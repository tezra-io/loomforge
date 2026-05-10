import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ProjectConfig } from "../config/index.js";
import { sanitizePrReview } from "../runners/pr-review-sanitizer.js";
import { prReviewPrompt } from "../runners/prompts/pr-reviewer.js";
import {
  NoopProjectArtifactWriter,
  type ProjectArtifactWriter,
} from "./project-artifact-writer.js";
import { buildMergePr, type ShippedIssue } from "./project-completion-pr.js";
import type {
  CreateProjectCompletionInput,
  EngineLogger,
  GhPrReviewPoster,
  PrReviewFinding,
  PrReviewOutcome,
  PrReviewResult,
  ProjectArtifactRecord,
  ProjectCompletionCoordinator,
  ProjectCompletionCoordinatorTrigger,
  ProjectCompletionIssue,
  ProjectCompletionRecord,
  ProjectCompletionRetryOutcome,
  ProjectCompletionStore,
  ProjectDiffSnapshotter,
  ProjectReviewerRunner,
  PullRequestManager,
  PullRequestSnapshot,
  RunRecord,
} from "./types.js";

export type ProjectCompletionTrigger = ProjectCompletionCoordinatorTrigger;
export type { ProjectCompletionCoordinator };

export interface ProjectCompletionCoordinatorOptions {
  store: ProjectCompletionStore;
  pullRequests: PullRequestManager;
  diffSnapshotter?: ProjectDiffSnapshotter;
  reviewer?: ProjectReviewerRunner;
  poster?: GhPrReviewPoster;
  artifactRoot?: string;
  artifactWriter?: ProjectArtifactWriter;
  leaseOwnerId?: string;
  leaseTtlMs?: number;
  logger?: EngineLogger;
  newId?: () => string;
  now?: () => string;
}

interface BatchSummary {
  shippedIssues: ProjectCompletionIssue[];
  alreadyComplete: string[];
  failed: string[];
  blocked: string[];
  cancelled: string[];
}

const NULL_LOGGER: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export class ProjectCompletionCoordinatorImpl implements ProjectCompletionCoordinator {
  private readonly store: ProjectCompletionStore;
  private readonly pullRequests: PullRequestManager;
  private readonly diffSnapshotter: ProjectDiffSnapshotter | null;
  private readonly reviewer: ProjectReviewerRunner | null;
  private readonly poster: GhPrReviewPoster | null;
  private readonly artifactRoot: string | null;
  private readonly artifactWriter: ProjectArtifactWriter;
  private readonly leaseOwnerId: string;
  private readonly leaseTtlMs: number;
  private readonly logger: EngineLogger;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(options: ProjectCompletionCoordinatorOptions) {
    this.store = options.store;
    this.pullRequests = options.pullRequests;
    this.diffSnapshotter = options.diffSnapshotter ?? null;
    this.reviewer = options.reviewer ?? null;
    this.poster = options.poster ?? null;
    this.artifactRoot = options.artifactRoot ?? null;
    this.artifactWriter = options.artifactWriter ?? new NoopProjectArtifactWriter();
    this.leaseOwnerId = options.leaseOwnerId ?? `coordinator-${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.logger = options.logger ?? NULL_LOGGER;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async startOrResume(trigger: ProjectCompletionTrigger): Promise<ProjectCompletionRecord> {
    const { project } = trigger;
    const summary = summarizeBatch(trigger.canonicalRuns);
    const createdAt = this.now();

    const input: CreateProjectCompletionInput = {
      id: this.newId(),
      projectSlug: project.slug,
      baseBranch: project.defaultBranch,
      devBranch: project.devBranch,
      shippedIssues: summary.shippedIssues,
      alreadyCompleteIssueIds: summary.alreadyComplete,
      failedIssueIds: summary.failed,
      blockedIssueIds: summary.blocked,
      cancelledIssueIds: summary.cancelled,
      postPrReviewComments: project.review.postPrReviewComments,
      blockingSeverities: project.review.blockingSeverities as Array<"P0" | "P1" | "P2">,
      reviewPartialPr: project.review.reviewPartialPr,
      createdAt,
    };

    const record = this.store.createOrResumeProjectCompletion(input);

    if (summary.shippedIssues.length === 0) {
      return this.markTerminal(record, project, {
        state: "skipped",
        failureReason: "zero_shipped_issues",
      });
    }

    const isPartial = summary.failed.length + summary.blocked.length + summary.cancelled.length > 0;
    if (isPartial && !project.review.reviewPartialPr) {
      return this.markTerminal(record, project, {
        state: "blocked",
        failureReason: "incomplete_batch",
      });
    }

    if (!this.acquireLease(record.id)) {
      this.logger.info(
        { completionId: record.id, projectSlug: project.slug },
        "another coordinator holds the completion lease; returning current state",
      );
      return this.store.getProjectCompletion(record.id) ?? record;
    }

    return this.driveReviewPath(record, project);
  }

  async retry(project: ProjectConfig): Promise<ProjectCompletionRetryOutcome> {
    const latest = this.store.getLatestProjectCompletion(project.slug);
    if (!latest) return { outcome: "no_completion" };

    if (!isRetryable(latest)) {
      return { outcome: "not_retryable", completion: latest };
    }

    if (!this.acquireLease(latest.id)) {
      return { outcome: "lease_held", completion: latest };
    }

    const reopened: ProjectCompletionRecord = {
      ...latest,
      state: latest.prUrl ? "reviewing" : "creating_pr",
      completedAt: null,
      updatedAt: this.now(),
    };
    this.store.updateProjectCompletion(reopened);

    const next = await this.driveReviewPath(reopened, project);
    return { outcome: "retried", completion: next };
  }

  private acquireLease(completionId: string): boolean {
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + this.leaseTtlMs).toISOString();
    return this.store.acquireProjectCompletionLease(
      completionId,
      this.leaseOwnerId,
      expiresAt,
      now,
    );
  }

  private async driveReviewPath(
    record: ProjectCompletionRecord,
    project: ProjectConfig,
  ): Promise<ProjectCompletionRecord> {
    const creating: ProjectCompletionRecord = {
      ...record,
      state: "creating_pr",
      updatedAt: this.now(),
    };
    this.store.updateProjectCompletion(creating);

    const shipped: ShippedIssue[] = creating.shippedIssues.map((issue) => ({
      id: issue.id,
      title: issue.title,
    }));
    const content = buildMergePr(project.slug, project.defaultBranch, shipped);

    const prResult = await this.pullRequests.createOrUpdatePr(project, content);
    if (prResult.outcome !== "success") {
      this.logger.warn(
        { projectSlug: project.slug, reason: prResult.reason, summary: prResult.summary },
        "PR create/update failed",
      );
      return this.markTerminal(creating, project, {
        state: "blocked",
        failureReason: "pr_creation_failed",
      });
    }

    const withPr = applyPullRequestSnapshot(creating, prResult.pullRequest);
    this.store.updateProjectCompletion({
      ...withPr,
      updatedAt: this.now(),
    });

    if (!project.review.postPrReviewComments) {
      return this.markTerminal(withPr, project, {
        state: "merge_ready",
        prReviewOutcome: "skipped_disabled",
      });
    }

    if (!this.diffSnapshotter || !this.reviewer || !this.poster) {
      this.logger.warn(
        { projectSlug: project.slug },
        "PR review enabled but reviewer dependencies not wired; falling back to skipped_disabled",
      );
      return this.markTerminal(withPr, project, {
        state: "merge_ready",
        prReviewOutcome: "skipped_disabled",
      });
    }

    return this.runReview(withPr, project, {
      diffSnapshotter: this.diffSnapshotter,
      reviewer: this.reviewer,
      poster: this.poster,
    });
  }

  private async runReview(
    record: ProjectCompletionRecord,
    project: ProjectConfig,
    deps: {
      diffSnapshotter: ProjectDiffSnapshotter;
      reviewer: ProjectReviewerRunner;
      poster: GhPrReviewPoster;
    },
  ): Promise<ProjectCompletionRecord> {
    const reviewing: ProjectCompletionRecord = {
      ...record,
      state: "reviewing",
      updatedAt: this.now(),
    };
    this.store.updateProjectCompletion(reviewing);

    const diff = await deps.diffSnapshotter.snapshot(project);
    if (diff.outcome !== "success") {
      this.logger.warn(
        { projectSlug: project.slug, reason: diff.reason, summary: diff.summary },
        "diff snapshot unavailable; skipping PR review",
      );
      return this.markTerminal(reviewing, project, {
        state: "merge_ready",
        prReviewOutcome: "skipped_diff_unavailable",
      });
    }

    const pullRequest = pullRequestFromRecord(reviewing);
    if (!pullRequest) {
      return this.markTerminal(reviewing, project, {
        state: "merge_ready",
        prReviewOutcome: "skipped_diff_unavailable",
      });
    }

    const artifactDir = this.resolveArtifactDir(project, reviewing.id);
    await this.persistDiffArtifact(artifactDir, reviewing.id, diff.diff);

    const prompt = prReviewPrompt({
      pullRequest,
      shippedIssues: reviewing.shippedIssues,
      diff: diff.diff,
    });
    await this.persistPromptArtifact(artifactDir, reviewing.id, prompt);
    await this.persistShippedIssuesArtifact(artifactDir, reviewing);

    const rawReview = await deps.reviewer.reviewProject({
      completion: reviewing,
      project,
      pullRequest,
      diff: diff.diff,
      shippedIssues: reviewing.shippedIssues,
      artifactDir,
    });

    if (rawReview.outcome === "blocked") {
      const blockedOutcome: PrReviewOutcome =
        rawReview.failureReason === "review_unparseable"
          ? "skipped_malformed"
          : "skipped_runner_blocked";
      return this.finalizeReview(reviewing, project, rawReview, blockedOutcome, null);
    }

    const sanitized = sanitizePrReview(rawReview, reviewing.shippedIssues);
    const review = sanitized.result;
    if (sanitized.report.removedFindings > 0 || sanitized.report.summaryRedacted) {
      this.logger.warn(
        {
          projectSlug: project.slug,
          completionId: reviewing.id,
          removedFindings: sanitized.report.removedFindings,
          summaryRedacted: sanitized.report.summaryRedacted,
        },
        "sanitized PR review for issue-text leaks before posting",
      );
    }

    if (review.outcome === "pass") {
      return this.finalizeReview(reviewing, project, review, "skipped_no_findings", null);
    }

    await this.persistPostedPayloadArtifact(artifactDir, reviewing.id, pullRequest, review);
    const postResult = await deps.poster.post(pullRequest, review);
    if (postResult.outcome === "post_failed") {
      this.logger.warn(
        { projectSlug: project.slug, summary: postResult.summary },
        "PR review post failed",
      );
      await this.persistPostFailureArtifact(artifactDir, reviewing.id, postResult.summary);
      return this.finalizeReview(reviewing, project, review, "post_failed", null);
    }
    return this.finalizeReview(reviewing, project, review, "posted", postResult.reviewUrl);
  }

  private async finalizeReview(
    record: ProjectCompletionRecord,
    project: ProjectConfig,
    review: PrReviewResult,
    outcome: PrReviewOutcome,
    reviewUrl: string | null,
  ): Promise<ProjectCompletionRecord> {
    this.store.saveProjectArtifact({
      id: this.newId(),
      completionId: record.id,
      kind: "pr-reviewer-stdout",
      path: review.rawLogPath,
      metadata: {
        outcome: review.outcome,
        findings: review.findings.length,
        prReviewOutcome: outcome,
      },
      createdAt: this.now(),
    });

    const completedAt = this.now();
    const next: ProjectCompletionRecord = {
      ...record,
      state: "merge_ready",
      reviewResult: review,
      prReviewOutcome: outcome,
      prReviewUrl: reviewUrl,
      findingCounts: countFindings(review.findings),
      updatedAt: completedAt,
      completedAt,
    };
    await this.persistHandoffArtifact(project, next);
    this.store.updateProjectCompletion(next);
    this.store.releaseProjectCompletionLease(next.id, this.leaseOwnerId, this.now());
    this.logger.info(
      {
        completionId: next.id,
        projectSlug: next.projectSlug,
        prReviewOutcome: outcome,
        findingCounts: next.findingCounts,
      },
      "project completion review terminal",
    );
    return next;
  }

  private resolveArtifactDir(project: ProjectConfig, completionId: string): string {
    const root = this.artifactRoot ?? `${project.runtimeDataRoot}/artifacts/projects`;
    return `${root}/${project.slug}/${completionId}`;
  }

  private async markTerminal(
    record: ProjectCompletionRecord,
    project: ProjectConfig,
    patch: Pick<ProjectCompletionRecord, "state"> &
      Partial<Pick<ProjectCompletionRecord, "failureReason" | "prReviewOutcome">>,
  ): Promise<ProjectCompletionRecord> {
    const completedAt = this.now();
    const next: ProjectCompletionRecord = {
      ...record,
      state: patch.state,
      failureReason: patch.failureReason ?? null,
      prReviewOutcome: patch.prReviewOutcome ?? record.prReviewOutcome,
      updatedAt: completedAt,
      completedAt,
    };
    await this.persistHandoffArtifact(project, next);
    this.store.updateProjectCompletion(next);
    this.store.releaseProjectCompletionLease(next.id, this.leaseOwnerId, this.now());
    this.logger.info(
      {
        completionId: next.id,
        projectSlug: next.projectSlug,
        state: next.state,
        failureReason: next.failureReason,
        prReviewOutcome: next.prReviewOutcome,
      },
      "project completion terminal",
    );
    return next;
  }

  private async persistHandoffArtifact(
    project: ProjectConfig,
    record: ProjectCompletionRecord,
  ): Promise<void> {
    const dir = this.resolveArtifactDir(project, record.id);
    const path = join(dir, "project-handoff.json");
    const handoff = {
      completionId: record.id,
      projectSlug: record.projectSlug,
      state: record.state,
      failureReason: record.failureReason,
      prUrl: record.prUrl,
      prNumber: record.prNumber,
      baseBranch: record.baseBranch,
      devBranch: record.devBranch,
      baseSha: record.baseSha,
      devSha: record.devSha,
      shippedIssueIds: record.shippedIssues.map((i) => i.id),
      alreadyCompleteIssueIds: record.alreadyCompleteIssueIds,
      failedIssueIds: record.failedIssueIds,
      blockedIssueIds: record.blockedIssueIds,
      cancelledIssueIds: record.cancelledIssueIds,
      prReviewOutcome: record.prReviewOutcome,
      prReviewUrl: record.prReviewUrl,
      findingCounts: record.findingCounts,
      reviewSummary: record.reviewResult?.summary ?? null,
      completedAt: record.completedAt,
      recommendedNextAction: recommendedNextAction(record),
    };
    await this.writeArtifact(path, JSON.stringify(handoff, null, 2) + "\n", record.id, {
      kind: "project-handoff",
      metadata: { state: record.state, prReviewOutcome: record.prReviewOutcome },
    });
  }

  private async persistDiffArtifact(
    artifactDir: string,
    completionId: string,
    diff: string,
  ): Promise<void> {
    const path = join(artifactDir, "pr-diff.patch");
    await this.writeArtifact(path, diff, completionId, { kind: "pr-diff", metadata: {} });
  }

  private async persistPromptArtifact(
    artifactDir: string,
    completionId: string,
    prompt: string,
  ): Promise<void> {
    const path = join(artifactDir, "pr-reviewer-prompt.txt");
    await this.writeArtifact(path, prompt, completionId, {
      kind: "pr-reviewer-prompt",
      metadata: {},
    });
  }

  private async persistShippedIssuesArtifact(
    artifactDir: string,
    record: ProjectCompletionRecord,
  ): Promise<void> {
    const path = join(artifactDir, "shipped-issues.json");
    await this.writeArtifact(
      path,
      JSON.stringify(record.shippedIssues, null, 2) + "\n",
      record.id,
      { kind: "shipped-issues", metadata: { count: record.shippedIssues.length } },
    );
  }

  private async persistPostedPayloadArtifact(
    artifactDir: string,
    completionId: string,
    pullRequest: PullRequestSnapshot,
    review: PrReviewResult,
  ): Promise<void> {
    const path = join(artifactDir, "pr-review-posted.json");
    const payload = {
      pullRequest: {
        url: pullRequest.url,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha,
        devSha: pullRequest.devSha,
      },
      summary: review.summary,
      findings: review.findings,
    };
    await this.writeArtifact(path, JSON.stringify(payload, null, 2) + "\n", completionId, {
      kind: "pr-review-posted",
      metadata: { findings: review.findings.length },
    });
  }

  private async persistPostFailureArtifact(
    artifactDir: string,
    completionId: string,
    summary: string,
  ): Promise<void> {
    const path = join(artifactDir, "gh-post-stderr.txt");
    await this.writeArtifact(path, summary, completionId, {
      kind: "gh-post-stderr",
      metadata: {},
    });
  }

  private async writeArtifact(
    path: string,
    contents: string,
    completionId: string,
    spec: { kind: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.artifactWriter.writeText(path, contents);
    } catch (error: unknown) {
      this.logger.warn(
        {
          completionId,
          kind: spec.kind,
          error: error instanceof Error ? error.message : String(error),
        },
        "failed to write project artifact file",
      );
      return;
    }
    this.store.saveProjectArtifact({
      id: this.newId(),
      completionId,
      kind: spec.kind,
      path,
      metadata: spec.metadata,
      createdAt: this.now(),
    });
  }
}

function isRetryable(record: ProjectCompletionRecord): boolean {
  if (
    record.state === "pending" ||
    record.state === "creating_pr" ||
    record.state === "reviewing"
  ) {
    return true;
  }
  if (record.state === "blocked") {
    return record.failureReason === "pr_creation_failed";
  }
  if (record.state === "merge_ready") {
    const outcome = record.prReviewOutcome;
    return (
      outcome === "post_failed" ||
      outcome === "skipped_diff_unavailable" ||
      outcome === "skipped_runner_blocked" ||
      outcome === "skipped_malformed"
    );
  }
  return false;
}

function recommendedNextAction(record: ProjectCompletionRecord): string {
  if (record.state === "merge_ready") {
    if (record.prReviewOutcome === "post_failed") return "retry_review_post";
    if (record.prReviewOutcome === "skipped_diff_unavailable") return "retry_review";
    if (record.prReviewOutcome === "skipped_runner_blocked") return "investigate_reviewer";
    if (record.prReviewOutcome === "skipped_malformed") return "investigate_reviewer_output";
    return "merge";
  }
  if (record.state === "blocked") {
    if (record.failureReason === "incomplete_batch") return "fix_failed_issues_then_retry";
    if (record.failureReason === "pr_creation_failed") return "retry_pr_creation";
    return "investigate";
  }
  if (record.state === "skipped") return "none";
  return "investigate";
}

function summarizeBatch(canonical: RunRecord[]): BatchSummary {
  const shippedIssues: ProjectCompletionIssue[] = [];
  const alreadyComplete: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const cancelled: string[] = [];

  for (const run of canonical) {
    if (run.state === "shipped") {
      shippedIssues.push(toCompletionIssue(run));
    } else if (run.state === "already_complete") {
      alreadyComplete.push(run.issueId);
    } else if (run.state === "failed") {
      failed.push(run.issueId);
    } else if (run.state === "blocked") {
      blocked.push(run.issueId);
    } else if (run.state === "cancelled") {
      cancelled.push(run.issueId);
    }
  }

  return { shippedIssues, alreadyComplete, failed, blocked, cancelled };
}

function toCompletionIssue(run: RunRecord): ProjectCompletionIssue {
  const commitShas: string[] = [];
  for (const attempt of run.attempts) {
    const sha = attempt.builderResult?.commitSha;
    if (sha) commitShas.push(sha);
  }
  return {
    id: run.issueId,
    title: run.issueSnapshot?.title ?? null,
    description: run.issueSnapshot?.description ?? null,
    acceptanceCriteria: run.issueSnapshot?.acceptanceCriteria ?? null,
    runId: run.id,
    commitShas,
  };
}

function pullRequestFromRecord(record: ProjectCompletionRecord): PullRequestSnapshot | null {
  if (
    record.prUrl === null ||
    record.prNumber === null ||
    record.baseSha === null ||
    record.devSha === null
  ) {
    return null;
  }
  return {
    url: record.prUrl,
    number: record.prNumber,
    baseBranch: record.baseBranch,
    devBranch: record.devBranch,
    baseSha: record.baseSha,
    devSha: record.devSha,
    body: "",
  };
}

function countFindings(findings: PrReviewFinding[]): {
  p0: number;
  p1: number;
  p2: number;
} {
  const counts = { p0: 0, p1: 0, p2: 0 };
  for (const finding of findings) {
    if (finding.severity === "P0") counts.p0 += 1;
    else if (finding.severity === "P1") counts.p1 += 1;
    else if (finding.severity === "P2") counts.p2 += 1;
  }
  return counts;
}

function applyPullRequestSnapshot(
  record: ProjectCompletionRecord,
  pr: PullRequestSnapshot,
): ProjectCompletionRecord {
  return {
    ...record,
    prUrl: pr.url,
    prNumber: pr.number,
    baseBranch: pr.baseBranch,
    devBranch: pr.devBranch,
    baseSha: pr.baseSha,
    devSha: pr.devSha,
  };
}

export type { ProjectArtifactRecord };
