import { randomUUID } from "node:crypto";

import type { ProjectConfig } from "../config/index.js";
import type {
  BlockedReason,
  BuilderResult,
  CancelReason,
  FailedReason,
  FailureReason,
  IssueSnapshot,
  ReviewResult,
  RevisionInput,
  RunAttemptRecord,
  RunEvent,
  RunHandoff,
  RunRecord,
  RunState,
  SubmitRunInput,
  SubmitRunResult,
  VerificationResult,
  WorkflowEngineOptions,
  WorkflowStepContext,
  WorkspaceSnapshot,
} from "./types.js";

export class WorkflowEngine {
  private activeRunId: string | null = null;
  private readonly queue: string[] = [];
  private readonly runs = new Map<string, RunRecord>();
  private readonly options: WorkflowEngineOptions;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(options: WorkflowEngineOptions) {
    this.options = options;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.recoverPersistedRuns();
  }

  submitRun(input: SubmitRunInput): SubmitRunResult {
    const project = this.projectForSlug(input.projectSlug);

    if (input.executionMode === "run_now_if_idle" && !this.isIdle()) {
      return {
        accepted: false,
        reason: "busy",
        currentRun: this.activeRunId ? this.getRun(this.activeRunId) : null,
        queuedRunIds: [...this.queue],
      };
    }

    this.options.store?.saveProject(project);
    const run = this.createRun(input.projectSlug, input.issueId);
    this.queue.push(run.id);
    this.refreshQueuePositions();
    this.persistRun(run);

    return {
      accepted: true,
      run,
      queuePosition: run.queuePosition ?? 1,
    };
  }

  getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  getQueue(): RunRecord[] {
    return this.queue.map((runId) => this.getRun(runId));
  }

  cancelRun(runId: string, reason: CancelReason = "operator_cancel"): RunRecord {
    const run = this.getRun(runId);
    if (isTerminalState(run.state)) {
      return run;
    }

    this.removeFromQueue(run.id);
    this.transitionRun(run, "cancelled", { failureReason: reason });
    return run;
  }

  async drainNext(): Promise<RunRecord | null> {
    if (this.activeRunId || this.queue.length === 0) {
      return null;
    }

    const runId = this.queue.shift();
    if (!runId) {
      return null;
    }

    this.refreshQueuePositions();
    const run = this.getRun(runId);
    run.queuePosition = null;
    this.persistRun(run);
    this.activeRunId = run.id;

    try {
      await this.executeRun(run);
      return run;
    } finally {
      this.activeRunId = null;
    }
  }

  async drainQueue(): Promise<RunRecord[]> {
    const processed: RunRecord[] = [];
    const maxRuns = this.queue.length;

    for (let count = 0; count < maxRuns; count += 1) {
      const run = await this.drainNext();
      if (!run) {
        return processed;
      }
      processed.push(run);
    }

    return processed;
  }

  private async executeRun(run: RunRecord): Promise<void> {
    const project = this.projectForSlug(run.projectSlug);

    try {
      const issue = await this.options.linear.fetchIssue(project, run.issueId);
      run.issueSnapshot = issue;
      this.persistRun(run);
      await this.prepareAndBuild(run, project, issue);
    } catch (error) {
      this.failInterruptedRun(run, error);
    }
  }

  private async prepareAndBuild(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
  ): Promise<void> {
    await this.transitionAndSync(run, project, issue, "preparing_workspace");
    const prepared = await this.options.worktrees.prepareWorkspace(project, issue);
    if (prepared.outcome === "blocked") {
      await this.finishBlocked(run, project, issue, prepared.reason, { summary: prepared.summary });
      return;
    }

    run.workspace = prepared.workspace;
    this.persistRun(run);
    await this.runAttemptsUntilReviewPasses(run, project, issue, prepared.workspace);
  }

  private async runAttemptsUntilReviewPasses(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
  ): Promise<void> {
    let revisionInput: RevisionInput | null = null;

    while (!isTerminalState(run.state)) {
      const attempt = this.createAttempt(run);
      const outcome = await this.runAttempt(run, project, issue, workspace, attempt, revisionInput);
      if (outcome === "review_passed") {
        await this.pushReviewedRun(run, project, issue, workspace, attempt);
        return;
      }
      if (outcome === "terminal") {
        return;
      }
      revisionInput = outcome;
    }
  }

  private async runAttempt(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
    attempt: RunAttemptRecord,
    revisionInput: RevisionInput | null,
  ): Promise<"review_passed" | "terminal" | RevisionInput> {
    await this.transitionAndSync(run, project, issue, "building");
    const context = { run, project, issue, workspace, attempt, revisionInput };
    const build = await this.options.builder.build(context);
    attempt.builderResult = build;
    this.touchAttempt(attempt);

    if (build.outcome !== "success") {
      await this.finishBuilderFailure(run, project, issue, build);
      return "terminal";
    }
    if (!build.commitSha) {
      await this.finishFailed(run, project, issue, "runner_error", { summary: build.summary });
      return "terminal";
    }

    return await this.verifyAndReview(run, project, issue, workspace, attempt, context);
  }

  private async verifyAndReview(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
    attempt: RunAttemptRecord,
    context: WorkflowStepContext,
  ): Promise<"review_passed" | "terminal" | RevisionInput> {
    await this.transitionAndSync(run, project, issue, "verifying");
    const verification = await this.options.verifier.verify(context);
    attempt.verificationResult = verification;
    this.touchAttempt(attempt);

    if (verification.outcome === "blocked") {
      await this.finishBlocked(run, project, issue, "env_failure", {
        summary: verification.summary,
      });
      return "terminal";
    }
    if (verification.outcome === "fail") {
      return await this.reviseOrFailVerification(run, project, issue, attempt, verification);
    }

    return await this.reviewVerifiedAttempt(run, project, issue, workspace, attempt, context);
  }

  private async reviewVerifiedAttempt(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    _workspace: WorkspaceSnapshot,
    attempt: RunAttemptRecord,
    context: WorkflowStepContext,
  ): Promise<"review_passed" | "terminal" | RevisionInput> {
    await this.transitionAndSync(run, project, issue, "reviewing");
    const review = await this.options.reviewer.review(context);
    attempt.reviewResult = review;
    this.touchAttempt(attempt);

    if (review.outcome === "pass") {
      attempt.outcome = "review_passed";
      this.touchAttempt(attempt);
      return "review_passed";
    }
    if (review.outcome === "blocked") {
      await this.finishBlocked(run, project, issue, "review_loop_exhausted", {
        summary: review.summary,
      });
      return "terminal";
    }

    return await this.reviseOrBlockReview(run, project, issue, attempt, review);
  }

  private async reviseOrFailVerification(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    attempt: RunAttemptRecord,
    verification: VerificationResult,
  ): Promise<"terminal" | RevisionInput> {
    if (!this.canRevise(run, project)) {
      await this.finishFailed(run, project, issue, "verification_failed", {
        summary: verification.summary,
      });
      return "terminal";
    }

    const revision = {
      source: "verification" as const,
      summary: verification.summary,
      findings: [],
    };
    await this.requestRevision(run, project, issue, attempt, revision);
    return revision;
  }

  private async reviseOrBlockReview(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    attempt: RunAttemptRecord,
    review: ReviewResult,
  ): Promise<"terminal" | RevisionInput> {
    if (!this.canRevise(run, project)) {
      await this.finishBlocked(run, project, issue, "review_loop_exhausted", {
        summary: review.summary,
      });
      return "terminal";
    }

    const revision = {
      source: "review" as const,
      summary: review.summary,
      findings: review.findings,
    };
    await this.requestRevision(run, project, issue, attempt, revision);
    return revision;
  }

  private async requestRevision(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    attempt: RunAttemptRecord,
    revision: RevisionInput,
  ): Promise<void> {
    run.revisionCount += 1;
    attempt.outcome = "revision_requested";
    this.touchAttempt(attempt);
    this.recordEvent(run, "revision_requested", "revising", {
      revisionCount: run.revisionCount,
      source: revision.source,
    });
    await this.transitionAndSync(run, project, issue, "revising");
  }

  private async pushReviewedRun(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
    attempt: RunAttemptRecord,
  ): Promise<void> {
    await this.transitionAndSync(run, project, issue, "ready_for_ship");
    const push = await this.options.builder.push({ run, project, issue, workspace, attempt });
    if (push.outcome === "blocked") {
      const candidate = push.failureReason ?? "runner_auth_missing";
      const reason: BlockedReason = isBlockedReason(candidate) ? candidate : "runner_auth_missing";
      await this.finishBlocked(run, project, issue, reason, { summary: push.summary });
      return;
    }
    if (push.outcome === "failed") {
      const candidate = push.failureReason ?? "push_failed";
      const reason: FailedReason = isFailedReason(candidate) ? candidate : "push_failed";
      await this.finishFailed(run, project, issue, reason, { summary: push.summary });
      return;
    }

    run.handoff = this.buildHandoff(run, project, workspace);
    this.persistRun(run);
    await this.transitionAndSync(run, project, issue, "shipped");
  }

  private async finishBuilderFailure(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    build: BuilderResult,
  ): Promise<void> {
    const reason = build.failureReason ?? "runner_error";
    if (build.outcome === "blocked" && isBlockedReason(reason)) {
      await this.finishBlocked(run, project, issue, reason, { summary: build.summary });
      return;
    }

    await this.finishFailed(run, project, issue, isFailedReason(reason) ? reason : "runner_error", {
      summary: build.summary,
    });
  }

  private async finishBlocked(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    reason: BlockedReason,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionAndSync(run, project, issue, "blocked", {
      failureReason: reason,
      details,
    });
  }

  private async finishFailed(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    reason: FailedReason,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionAndSync(run, project, issue, "failed", { failureReason: reason, details });
  }

  private failInterruptedRun(run: RunRecord, error: unknown): void {
    if (isTerminalState(run.state)) {
      return;
    }

    this.transitionRun(run, "failed", {
      failureReason: "runner_error",
      details: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  private async transitionAndSync(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    state: RunState,
    options: {
      failureReason?: FailureReason;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    this.transitionRun(run, state, options);
    const statusName = linearStatusForState(project, state);
    if (statusName) {
      await this.options.linear.updateIssueStatus(project, issue, statusName);
    }
  }

  private transitionRun(
    run: RunRecord,
    state: RunState,
    options: {
      failureReason?: FailureReason;
      details?: Record<string, unknown>;
    } = {},
  ): void {
    run.state = state;
    run.updatedAt = this.now();
    run.failureReason = options.failureReason ?? null;
    this.recordEvent(run, "state_transition", state, options.details ?? {});
    this.persistRun(run);
  }

  private createRun(projectSlug: string, issueId: string): RunRecord {
    const now = this.now();
    const run: RunRecord = {
      id: this.newId(),
      projectSlug,
      issueId,
      state: "queued",
      failureReason: null,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      queuePosition: null,
      issueSnapshot: null,
      workspace: null,
      attempts: [],
      events: [],
      handoff: null,
    };

    this.runs.set(run.id, run);
    this.recordEvent(run, "state_transition", "queued", {});
    return run;
  }

  private createAttempt(run: RunRecord): RunAttemptRecord {
    const now = this.now();
    const attempt = {
      id: this.newId(),
      runId: run.id,
      attemptNumber: run.attempts.length + 1,
      outcome: null,
      builderResult: null,
      verificationResult: null,
      reviewResult: null,
      createdAt: now,
      updatedAt: now,
    };

    run.attempts.push(attempt);
    this.recordEvent(run, "attempt_created", run.state, { attemptId: attempt.id });
    this.persistRun(run);
    return attempt;
  }

  private buildHandoff(
    run: RunRecord,
    project: ProjectConfig,
    workspace: WorkspaceSnapshot,
  ): RunHandoff {
    const changedFiles = new Set<string>();
    const commitShas: string[] = [];

    for (const attempt of run.attempts) {
      for (const file of attempt.builderResult?.changedFiles ?? []) {
        changedFiles.add(file);
      }
      if (attempt.builderResult?.commitSha) {
        commitShas.push(attempt.builderResult.commitSha);
      }
    }

    const lastAttempt = run.attempts.at(-1) ?? null;
    return {
      version: 1,
      runId: run.id,
      status: "shipped",
      workspacePath: workspace.path,
      branchName: workspace.branchName,
      changedFiles: [...changedFiles],
      commitShas,
      remotePushStatus: "pushed",
      verification: lastAttempt?.verificationResult ?? null,
      review: lastAttempt?.reviewResult ?? null,
      linearStatus: project.linearStatuses.done,
      recommendedNextAction: "merge",
    };
  }

  private canRevise(run: RunRecord, project: ProjectConfig): boolean {
    return run.revisionCount < project.review.maxRevisionLoops;
  }

  private isIdle(): boolean {
    return this.activeRunId === null && this.queue.length === 0;
  }

  private projectForSlug(projectSlug: string): ProjectConfig {
    const project = this.options.registry.bySlug.get(projectSlug);
    if (!project) {
      throw new Error(`Unknown project slug: ${projectSlug}`);
    }
    return project;
  }

  private refreshQueuePositions(): void {
    for (const [index, runId] of this.queue.entries()) {
      const run = this.getRun(runId);
      run.queuePosition = index + 1;
      this.persistRun(run);
    }
  }

  private removeFromQueue(runId: string): void {
    const index = this.queue.indexOf(runId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.refreshQueuePositions();
    }
  }

  private recordEvent(
    run: RunRecord,
    type: RunEvent["type"],
    state: RunState,
    details: Record<string, unknown>,
  ): void {
    run.events.push({
      id: this.newId(),
      runId: run.id,
      type,
      state,
      createdAt: this.now(),
      details,
    });
  }

  private touchAttempt(attempt: RunAttemptRecord): void {
    attempt.updatedAt = this.now();
    this.persistRun(this.getRun(attempt.runId));
  }

  private persistRun(run: RunRecord): void {
    this.options.store?.saveRun(run);
  }

  private recoverPersistedRuns(): void {
    const recoverableRuns = this.options.store?.listRecoverableRuns() ?? [];

    for (const run of recoverableRuns) {
      const recovered = this.recoverRunForRestart(run);
      this.runs.set(recovered.id, recovered);
      this.queue.push(recovered.id);
    }

    this.refreshQueuePositions();
  }

  private recoverRunForRestart(run: RunRecord): RunRecord {
    if (run.state === "queued") {
      return run;
    }

    const recoveredFromState = run.state;
    run.state = "queued";
    run.failureReason = null;
    run.queuePosition = null;
    run.updatedAt = this.now();
    run.events.push({
      id: this.newId(),
      runId: run.id,
      type: "state_transition",
      state: "queued",
      createdAt: this.now(),
      details: {
        recoveryReason: "daemon_restart",
        recoveredFromState,
      },
    });
    return run;
  }
}

export function isTerminalState(state: RunState): boolean {
  return state === "shipped" || state === "blocked" || state === "failed" || state === "cancelled";
}

function linearStatusForState(project: ProjectConfig, state: RunState): string | null {
  if (state === "preparing_workspace" || state === "building") {
    return project.linearStatuses.inProgress;
  }
  if (state === "reviewing") {
    return project.linearStatuses.inReview;
  }
  if (state === "shipped") {
    return project.linearStatuses.done;
  }
  if (state === "blocked" || state === "failed") {
    return project.linearStatuses.blocked;
  }
  return null;
}

function isBlockedReason(reason: FailureReason): reason is BlockedReason {
  return (
    reason === "rebase_conflict" ||
    reason === "runner_auth_missing" ||
    reason === "dirty_workspace" ||
    reason === "review_loop_exhausted" ||
    reason === "env_failure"
  );
}

function isFailedReason(reason: FailureReason): reason is FailedReason {
  return (
    reason === "timeout" ||
    reason === "verification_failed" ||
    reason === "runner_error" ||
    reason === "workspace_error" ||
    reason === "recovery_error" ||
    reason === "push_failed"
  );
}
