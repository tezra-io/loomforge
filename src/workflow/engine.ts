import { randomUUID } from "node:crypto";

import type { ProjectConfig } from "../config/index.js";
import { LinearAuthError } from "../linear/index.js";
import { buildMergePr, type ShippedIssue } from "./project-completion-pr.js";
import type {
  ArtifactMeta,
  ArtifactWriter,
  BlockedReason,
  BuilderResult,
  CancelReason,
  EngineLogger,
  FailedReason,
  FailureReason,
  IssueSnapshot,
  RevisionInput,
  RunAttemptRecord,
  RunEvent,
  RunHandoff,
  RunRecord,
  RunSource,
  RunState,
  SubmitProjectResult,
  SubmitRunInput,
  SubmitRunResult,
  CleanupWorkspaceResult,
  ProjectCompletionResult,
  WorkflowEngineOptions,
  WorkflowStepContext,
  WorkspaceSnapshot,
} from "./types.js";

const noopLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WorkflowEngine {
  private activeRunId: string | null = null;
  private readonly queue: string[] = [];
  private readonly runs = new Map<string, RunRecord>();
  private readonly options: WorkflowEngineOptions;
  private readonly log: EngineLogger;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(options: WorkflowEngineOptions) {
    this.options = options;
    this.log = options.logger ?? noopLogger;
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
    const run = this.createRun(input.projectSlug, input.issueId, input.source ?? "linear");
    this.queue.push(run.id);
    this.refreshQueuePositions();
    this.persistRun(run);

    return {
      accepted: true,
      run,
      queuePosition: run.queuePosition ?? 1,
    };
  }

  async submitProject(projectSlug: string): Promise<SubmitProjectResult> {
    const project = this.projectForSlug(projectSlug);
    const issues = await this.options.linear.listProjectIssues(project);
    const activeIssueIds = this.activeIssueIdsForProject(projectSlug);

    const enqueued: SubmitProjectResult["enqueued"] = [];
    const skipped: SubmitProjectResult["skipped"] = [];

    for (const issue of issues) {
      if (activeIssueIds.has(issue.identifier)) {
        skipped.push({ issueId: issue.identifier, reason: "already_active" });
        continue;
      }

      this.options.store?.saveProject(project);
      const run = this.createRun(projectSlug, issue.identifier, "linear");
      this.queue.push(run.id);
      this.refreshQueuePositions();
      this.persistRun(run);
      enqueued.push({
        runId: run.id,
        issueId: issue.identifier,
        queuePosition: run.queuePosition ?? this.queue.length,
      });
    }

    return {
      projectSlug,
      enqueued,
      skipped,
      totalIssues: issues.length,
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

  getProjectStatus(projectSlug: string): ProjectCompletionResult & { done: boolean } {
    this.projectForSlug(projectSlug);
    const projectRuns = [...this.runs.values()].filter((r) => r.projectSlug === projectSlug);
    const canonical = latestRunPerIssue(projectRuns);

    const shipped: string[] = [];
    const alreadyComplete: string[] = [];
    const failed: string[] = [];
    const blocked: string[] = [];
    const cancelled: string[] = [];
    const inProgress: string[] = [];

    for (const r of canonical) {
      if (r.state === "shipped") shipped.push(r.issueId);
      else if (r.state === "already_complete") alreadyComplete.push(r.issueId);
      else if (r.state === "failed") failed.push(r.issueId);
      else if (r.state === "blocked") blocked.push(r.issueId);
      else if (r.state === "cancelled") cancelled.push(r.issueId);
      else inProgress.push(r.issueId);
    }

    return {
      done: inProgress.length === 0 && canonical.length > 0,
      projectSlug,
      shipped,
      alreadyComplete,
      failed,
      blocked,
      cancelled,
      pullRequestUrl: null,
    };
  }

  cancelRun(runId: string, reason: CancelReason = "operator_cancel"): RunRecord {
    const run = this.getRun(runId);
    if (isTerminalState(run.state)) {
      return run;
    }
    if (run.id === this.activeRunId) {
      throw new Error("Cannot cancel an active run; wait for it to finish or restart the daemon");
    }

    this.removeFromQueue(run.id);
    this.transitionRun(run, "cancelled", { failureReason: reason });
    return run;
  }

  retryRun(runId: string): RunRecord {
    const run = this.getRun(runId);
    if (run.state !== "failed" && run.state !== "blocked") {
      throw new Error(`Cannot retry run in state: ${run.state}`);
    }

    const previousState = run.state;
    run.state = "queued";
    run.failureReason = null;
    run.queuePosition = null;
    run.revisionCount = 0;
    run.attempts = [];
    run.handoff = null;
    run.workspace = null;
    run.updatedAt = this.now();
    this.recordEvent(run, "state_transition", "queued", { retryFromState: previousState });
    this.queue.push(run.id);
    this.refreshQueuePositions();
    this.persistRun(run);
    return run;
  }

  async cleanupWorkspace(projectSlug: string): Promise<CleanupWorkspaceResult> {
    const project = this.projectForSlug(projectSlug);
    return this.options.worktrees.cleanupWorkspace(project);
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
    this.log.info({ runId: run.id, issueId: run.issueId, source: run.source }, "executing run");

    try {
      await this.executeRun(run);
      if (isTerminalState(run.state)) {
        await this.checkProjectCompletion(run.projectSlug);
      }
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
      await this.writeArtifact(run, "issue_snapshot", (w) => w.writeIssueSnapshot(run.id, issue));
      await this.prepareAndBuild(run, project, issue);
    } catch (error) {
      if (error instanceof LinearAuthError) {
        this.transitionRun(run, "blocked", {
          failureReason: "runner_auth_missing",
          details: { error: error.message },
        });
        return;
      }
      this.log.error(
        { runId: run.id, error: error instanceof Error ? error.message : String(error) },
        "run execution error",
      );
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
    await this.buildReviewAndPush(run, project, issue, prepared.workspace);
  }

  private async buildReviewAndPush(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
  ): Promise<void> {
    const attempt = this.createAttempt(run);
    const buildOk = await this.buildStep(run, project, issue, workspace, attempt, null);
    if (!buildOk) return;

    const context = { run, project, issue, workspace, attempt, revisionInput: null };
    const reviewOutcome = await this.reviewStep(run, project, issue, attempt, context);
    if (reviewOutcome === "terminal") return;

    if (reviewOutcome === "revise") {
      const revision: RevisionInput = {
        source: "review",
        summary: attempt.reviewResult?.summary ?? "",
        findings: attempt.reviewResult?.findings ?? [],
      };
      run.revisionCount += 1;
      attempt.outcome = "revision_requested";
      this.touchAttempt(attempt);
      this.recordEvent(run, "revision_requested", "revising", { source: "review" });
      await this.transitionAndSync(run, project, issue, "revising");

      const revisionAttempt = this.createAttempt(run);
      const revisionBuildOk = await this.buildStep(
        run,
        project,
        issue,
        workspace,
        revisionAttempt,
        revision,
      );
      if (!revisionBuildOk) return;
    }

    const pushAttempt = run.attempts.at(-1);
    if (!pushAttempt) return;
    await this.pushReviewedRun(run, project, issue, workspace, pushAttempt);
  }

  private async buildStep(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    workspace: WorkspaceSnapshot,
    attempt: RunAttemptRecord,
    revisionInput: RevisionInput | null,
  ): Promise<boolean> {
    await this.transitionAndSync(run, project, issue, "building");
    const context = { run, project, issue, workspace, attempt, revisionInput };
    const build = await this.options.builder.build(context);
    attempt.builderResult = build;
    this.touchAttempt(attempt);

    if (build.outcome === "no_changes") {
      await this.transitionAndSync(run, project, issue, "already_complete", {
        details: { summary: build.summary },
      });
      return false;
    }
    if (build.outcome !== "success") {
      await this.finishBuilderFailure(run, project, issue, build);
      return false;
    }
    if (!build.commitSha) {
      await this.finishFailed(run, project, issue, "runner_error", { summary: build.summary });
      return false;
    }
    return true;
  }

  private async reviewStep(
    run: RunRecord,
    project: ProjectConfig,
    issue: IssueSnapshot,
    attempt: RunAttemptRecord,
    context: WorkflowStepContext,
  ): Promise<"pass" | "revise" | "terminal"> {
    await this.transitionAndSync(run, project, issue, "reviewing");
    const review = await this.options.reviewer.review(context);
    attempt.reviewResult = review;
    this.touchAttempt(attempt);

    if (review.outcome === "pass") {
      attempt.outcome = "review_passed";
      this.touchAttempt(attempt);
      return "pass";
    }
    if (review.outcome === "blocked") {
      const reason = review.failureReason ?? "review_loop_exhausted";
      await this.finishBlocked(run, project, issue, reason, {
        summary: review.summary,
      });
      return "terminal";
    }
    return "revise";
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

    const handoff = this.buildHandoff(run, project, workspace);
    run.handoff = handoff;
    this.persistRun(run);
    await this.writeArtifact(run, "handoff", (w) => w.writeHandoff(run.id, handoff));
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

    const project = this.projectForSlug(run.projectSlug);
    const opts = {
      failureReason: "runner_error" as const,
      details: { error: error instanceof Error ? error.message : String(error) },
    };

    if (run.issueSnapshot) {
      void this.transitionAndSync(run, project, run.issueSnapshot, "failed", opts);
    } else {
      this.transitionRun(run, "failed", opts);
    }
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
      try {
        await this.options.linear.updateIssueStatus(project, issue, statusName);
      } catch (error: unknown) {
        this.recordEvent(run, "linear_sync_failed", state, {
          statusName,
          error: error instanceof Error ? error.message : String(error),
        });
        this.persistRun(run);
      }
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
    const prevState = run.state;
    run.state = state;
    run.updatedAt = this.now();
    run.failureReason = options.failureReason ?? null;
    this.recordEvent(run, "state_transition", state, options.details ?? {});
    this.persistRun(run);

    const logData = { runId: run.id, issueId: run.issueId, from: prevState, to: state };
    if (state === "failed" || state === "blocked") {
      this.log.warn(
        { ...logData, failureReason: options.failureReason, details: options.details },
        `run ${state}`,
      );
    } else {
      this.log.info(logData, `run ${prevState} → ${state}`);
    }
  }

  private createRun(projectSlug: string, issueId: string, source: RunSource): RunRecord {
    const now = this.now();
    const run: RunRecord = {
      id: this.newId(),
      projectSlug,
      issueId,
      source,
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

  private activeIssueIdsForProject(projectSlug: string): Set<string> {
    const ids = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.projectSlug === projectSlug && !isTerminalState(run.state)) {
        ids.add(run.issueId);
      }
    }
    return ids;
  }

  private async checkProjectCompletion(projectSlug: string): Promise<void> {
    const activeIds = this.activeIssueIdsForProject(projectSlug);
    if (activeIds.size > 0) return;

    const projectRuns = [...this.runs.values()].filter((r) => r.projectSlug === projectSlug);
    if (projectRuns.length === 0) return;
    const canonical = latestRunPerIssue(projectRuns);

    const shipped: string[] = [];
    const alreadyComplete: string[] = [];
    const shippedIssues: ShippedIssue[] = [];
    const failed: string[] = [];
    const blocked: string[] = [];
    const cancelled: string[] = [];

    for (const r of canonical) {
      if (r.state === "shipped") {
        shipped.push(r.issueId);
        shippedIssues.push({ id: r.issueId, title: r.issueSnapshot?.title ?? null });
      } else if (r.state === "already_complete") alreadyComplete.push(r.issueId);
      else if (r.state === "failed") failed.push(r.issueId);
      else if (r.state === "blocked") blocked.push(r.issueId);
      else if (r.state === "cancelled") cancelled.push(r.issueId);
    }

    let pullRequestUrl: string | null = null;
    if (shippedIssues.length > 0 && this.options.pullRequests) {
      const project = this.projectForSlug(projectSlug);
      const { title, body } = buildMergePr(projectSlug, project.defaultBranch, shippedIssues);

      try {
        const pr = await this.options.pullRequests.createPr(project, title, body);
        pullRequestUrl = pr?.url ?? null;
        if (pullRequestUrl) {
          this.log.info({ projectSlug, pullRequestUrl }, "created PR for project");
        }
      } catch (error: unknown) {
        this.log.warn(
          { projectSlug, error: error instanceof Error ? error.message : String(error) },
          "failed to create PR",
        );
      }
    }

    const result: ProjectCompletionResult = {
      projectSlug,
      shipped,
      alreadyComplete,
      failed,
      blocked,
      cancelled,
      pullRequestUrl,
    };

    this.log.info(
      {
        projectSlug,
        shipped: shipped.length,
        alreadyComplete: alreadyComplete.length,
        failed: failed.length,
        blocked: blocked.length,
      },
      "project complete",
    );

    this.options.onProjectComplete?.(result);
  }

  private isIdle(): boolean {
    return this.activeRunId === null && this.queue.length === 0;
  }

  setRegistry(registry: WorkflowEngineOptions["registry"]): void {
    this.options.registry = registry;
  }

  getRegistry(): WorkflowEngineOptions["registry"] {
    return this.options.registry;
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

  private async writeArtifact(
    run: RunRecord,
    idSuffix: string,
    write: (w: ArtifactWriter) => Promise<ArtifactMeta>,
  ): Promise<void> {
    if (!this.options.artifacts) {
      return;
    }
    const meta = await write(this.options.artifacts);
    this.options.store?.saveArtifact({
      id: `${run.id}:${idSuffix}`,
      runId: run.id,
      kind: meta.kind,
      path: meta.path,
      metadata: meta.metadata,
      createdAt: this.now(),
    });
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
  return (
    state === "shipped" ||
    state === "already_complete" ||
    state === "blocked" ||
    state === "failed" ||
    state === "cancelled"
  );
}

function latestRunPerIssue(runs: RunRecord[]): RunRecord[] {
  const byIssue = new Map<string, RunRecord>();
  for (const run of runs) {
    const existing = byIssue.get(run.issueId);
    if (!existing || run.updatedAt >= existing.updatedAt) {
      byIssue.set(run.issueId, run);
    }
  }
  return [...byIssue.values()];
}

function linearStatusForState(project: ProjectConfig, state: RunState): string | null {
  if (state === "preparing_workspace" || state === "building") {
    return project.linearStatuses.inProgress;
  }
  if (state === "reviewing") {
    return project.linearStatuses.inReview;
  }
  if (state === "shipped" || state === "already_complete") {
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
