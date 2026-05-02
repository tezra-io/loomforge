import type { ProjectConfig, ProjectConfigRegistry } from "../config/index.js";

export type ExecutionMode = "run_now_if_idle" | "enqueue";

export type RunSource = "linear" | "adhoc";

export type RunState =
  | "queued"
  | "preparing_workspace"
  | "building"
  | "verifying"
  | "reviewing"
  | "revising"
  | "ready_for_ship"
  | "shipped"
  | "already_complete"
  | "blocked"
  | "failed"
  | "cancelled";

export type FailedReason =
  | "timeout"
  | "verification_failed"
  | "runner_error"
  | "workspace_error"
  | "recovery_error"
  | "push_failed";

export type BlockedReason =
  | "rebase_conflict"
  | "runner_auth_missing"
  | "dirty_workspace"
  | "review_loop_exhausted"
  | "review_unparseable"
  | "env_failure";

export type CancelReason = "operator_cancel" | "daemon_shutdown";
export type FailureReason = FailedReason | BlockedReason | CancelReason;

export interface SubmitRunInput {
  projectSlug: string;
  issueId: string;
  executionMode: ExecutionMode;
  source?: RunSource;
}

export interface IssueSnapshot {
  identifier: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  labels: string[];
  comments: string[];
  priority: string | null;
}

export interface WorkspaceSnapshot {
  path: string;
  branchName: string;
}

export interface BuilderResult {
  outcome: "success" | "no_changes" | "failed" | "blocked";
  summary: string;
  changedFiles: string[];
  commitSha: string | null;
  rawLogPath: string;
  failureReason?: FailedReason | BlockedReason;
}

export interface PushResult {
  outcome: "success" | "failed" | "blocked";
  summary: string;
  rawLogPath: string;
  failureReason?: "push_failed" | "runner_auth_missing" | "runner_error";
}

export interface VerificationCommandResult {
  name: string;
  command: string;
  outcome: "pass" | "fail";
  rawLogPath: string;
}

export interface VerificationResult {
  outcome: "pass" | "fail" | "blocked";
  summary: string;
  rawLogPath: string;
  commandResults: VerificationCommandResult[];
  failureReason?: "verification_failed" | "env_failure" | "timeout";
}

export interface ReviewFinding {
  severity: "P0" | "P1" | "P2";
  title: string;
  detail: string;
  file?: string;
}

export interface ReviewResult {
  outcome: "pass" | "revise" | "blocked";
  findings: ReviewFinding[];
  summary: string;
  rawLogPath: string;
  failureReason?: BlockedReason;
}

export interface RevisionInput {
  source: "verification" | "review";
  summary: string;
  findings: ReviewFinding[];
}

export interface RunAttemptRecord {
  id: string;
  runId: string;
  attemptNumber: number;
  outcome: string | null;
  builderResult: BuilderResult | null;
  verificationResult: VerificationResult | null;
  reviewResult: ReviewResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: "state_transition" | "attempt_created" | "revision_requested" | "linear_sync_failed";
  state: RunState;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface RunHandoff {
  version: 1;
  runId: string;
  status: RunState;
  workspacePath: string;
  branchName: string;
  changedFiles: string[];
  commitShas: string[];
  remotePushStatus: "pushed" | "not_pushed";
  verification: VerificationResult | null;
  review: ReviewResult | null;
  linearStatus: string;
  recommendedNextAction: "merge" | "blocked" | "retry" | "manual_review";
}

export interface RunRecord {
  id: string;
  projectSlug: string;
  issueId: string;
  source: RunSource;
  state: RunState;
  failureReason: FailureReason | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  queuePosition: number | null;
  issueSnapshot: IssueSnapshot | null;
  workspace: WorkspaceSnapshot | null;
  attempts: RunAttemptRecord[];
  events: RunEvent[];
  handoff: RunHandoff | null;
}

export interface SubmitRunAccepted {
  accepted: true;
  run: RunRecord;
  queuePosition: number;
}

export interface SubmitRunRejected {
  accepted: false;
  reason: "busy";
  currentRun: RunRecord | null;
  queuedRunIds: string[];
}

export type SubmitRunResult = SubmitRunAccepted | SubmitRunRejected;

export interface SubmitProjectResult {
  projectSlug: string;
  enqueued: Array<{ runId: string; issueId: string; queuePosition: number }>;
  skipped: Array<{ issueId: string; reason: string }>;
  totalIssues: number;
}

export interface PrepareWorkspaceSuccess {
  outcome: "success";
  workspace: WorkspaceSnapshot;
}

export interface PrepareWorkspaceBlocked {
  outcome: "blocked";
  reason: "rebase_conflict" | "dirty_workspace" | "env_failure";
  summary: string;
}

export type PrepareWorkspaceResult = PrepareWorkspaceSuccess | PrepareWorkspaceBlocked;

export interface WorkflowStepContext {
  run: RunRecord;
  project: ProjectConfig;
  issue: IssueSnapshot;
  workspace: WorkspaceSnapshot;
  attempt: RunAttemptRecord;
  revisionInput: RevisionInput | null;
}

export interface PushContext {
  run: RunRecord;
  project: ProjectConfig;
  issue: IssueSnapshot;
  workspace: WorkspaceSnapshot;
  attempt: RunAttemptRecord;
}

export interface LinearIssueSummary {
  identifier: string;
  title: string;
  priority: number;
  number: number;
}

export interface LinearWorkflowClient {
  fetchIssue(project: ProjectConfig, issueId: string): Promise<IssueSnapshot>;
  listProjectIssues(project: ProjectConfig): Promise<LinearIssueSummary[]>;
  updateIssueStatus(
    project: ProjectConfig,
    issue: IssueSnapshot,
    statusName: string,
  ): Promise<void>;
}

export interface CleanupWorkspaceResult {
  outcome: "success" | "failed";
  summary: string;
}

export interface WorktreeManager {
  prepareWorkspace(project: ProjectConfig, issue: IssueSnapshot): Promise<PrepareWorkspaceResult>;
  cleanupWorkspace(project: ProjectConfig): Promise<CleanupWorkspaceResult>;
}

export interface BuilderRunner {
  build(context: WorkflowStepContext): Promise<BuilderResult>;
  push(context: PushContext): Promise<PushResult>;
}

export interface ReviewerRunner {
  review(context: WorkflowStepContext): Promise<ReviewResult>;
}

export interface ArtifactMeta {
  kind: string;
  path: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactWriter {
  writeIssueSnapshot(runId: string, snapshot: IssueSnapshot): Promise<ArtifactMeta>;
  writeHandoff(runId: string, handoff: RunHandoff): Promise<ArtifactMeta>;
}

export interface WorkflowRunStore {
  saveProject(project: ProjectConfig): void;
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | null;
  listRecoverableRuns(): RunRecord[];
  saveArtifact(artifact: {
    id: string;
    runId: string;
    kind: string;
    path: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): void;
  listArtifacts(runId: string): Array<{
    id: string;
    runId: string;
    kind: string;
    path: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface PrReviewFinding {
  severity: "P0" | "P1" | "P2";
  title: string;
  detail: string;
  file?: string;
  startLine?: number;
  endLine?: number;
}

export interface PrReviewResult {
  outcome: "pass" | "findings" | "blocked";
  findings: PrReviewFinding[];
  summary: string;
  rawLogPath: string;
  failureReason?: BlockedReason;
}

export type ProjectCompletionState =
  | "pending"
  | "creating_pr"
  | "reviewing"
  | "merge_ready"
  | "blocked"
  | "skipped";

export type ProjectCompletionFailureReason =
  | "incomplete_batch"
  | "zero_shipped_issues"
  | "pr_creation_failed"
  | "env_failure";

export type PrReviewOutcome =
  | "posted"
  | "skipped_no_findings"
  | "skipped_disabled"
  | "skipped_diff_unavailable"
  | "skipped_malformed"
  | "skipped_runner_blocked"
  | "post_failed";

export interface ProjectCompletionIssue {
  id: string;
  title: string | null;
  description: string | null;
  acceptanceCriteria: string | null;
  runId: string;
  commitShas: string[];
}

export interface ProjectCompletionRecord {
  id: string;
  projectSlug: string;
  state: ProjectCompletionState;
  failureReason: ProjectCompletionFailureReason | null;
  prUrl: string | null;
  prNumber: number | null;
  baseBranch: string;
  devBranch: string;
  baseSha: string | null;
  devSha: string | null;
  shippedIssues: ProjectCompletionIssue[];
  alreadyCompleteIssueIds: string[];
  failedIssueIds: string[];
  blockedIssueIds: string[];
  cancelledIssueIds: string[];
  reviewResult: PrReviewResult | null;
  prReviewOutcome: PrReviewOutcome | null;
  prReviewUrl: string | null;
  findingCounts: { p0: number; p1: number; p2: number };
  postPrReviewComments: boolean;
  blockingSeverities: Array<"P0" | "P1" | "P2">;
  reviewPartialPr: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateProjectCompletionInput {
  id: string;
  projectSlug: string;
  baseBranch: string;
  devBranch: string;
  shippedIssues: ProjectCompletionIssue[];
  alreadyCompleteIssueIds: string[];
  failedIssueIds: string[];
  blockedIssueIds: string[];
  cancelledIssueIds: string[];
  postPrReviewComments: boolean;
  blockingSeverities: Array<"P0" | "P1" | "P2">;
  reviewPartialPr: boolean;
  createdAt: string;
}

export interface ProjectArtifactRecord {
  id: string;
  completionId: string;
  kind: string;
  path: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectCompletionStore {
  createOrResumeProjectCompletion(input: CreateProjectCompletionInput): ProjectCompletionRecord;
  updateProjectCompletion(record: ProjectCompletionRecord): void;
  getProjectCompletion(id: string): ProjectCompletionRecord | null;
  getLatestProjectCompletion(projectSlug: string): ProjectCompletionRecord | null;
  listActiveProjectCompletions(): ProjectCompletionRecord[];
  acquireProjectCompletionLease(
    completionId: string,
    ownerId: string,
    expiresAt: string,
    now: string,
  ): boolean;
  releaseProjectCompletionLease(completionId: string, ownerId: string, now: string): void;
  saveProjectArtifact(artifact: ProjectArtifactRecord): void;
  listProjectArtifacts(completionId: string): ProjectArtifactRecord[];
}

export interface ProjectCompletionResult {
  projectSlug: string;
  shipped: string[];
  alreadyComplete: string[];
  failed: string[];
  blocked: string[];
  cancelled: string[];
  pullRequestUrl: string | null;
}

export interface EngineLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PullRequestCreator {
  createPr(project: ProjectConfig, title: string, body: string): Promise<{ url: string } | null>;
}

export interface MergePrContent {
  title: string;
  body: string;
}

export interface PullRequestSnapshot {
  url: string;
  number: number;
  baseBranch: string;
  devBranch: string;
  baseSha: string;
  devSha: string;
  body: string;
}

export type CreateOrUpdatePrResult =
  | { outcome: "success"; pullRequest: PullRequestSnapshot }
  | { outcome: "failed"; reason: "push_failed" | "gh_failed"; summary: string };

export interface PullRequestManager {
  createOrUpdatePr(
    project: ProjectConfig,
    content: MergePrContent,
  ): Promise<CreateOrUpdatePrResult>;
}

export type DiffSnapshotResult =
  | { outcome: "success"; diff: string; baseSha: string; devSha: string }
  | {
      outcome: "unavailable";
      reason: "fetch_failed" | "diff_failed";
      summary: string;
    };

export interface ProjectDiffSnapshotter {
  snapshot(project: ProjectConfig): Promise<DiffSnapshotResult>;
}

export interface ProjectReviewContext {
  completion: ProjectCompletionRecord;
  project: ProjectConfig;
  pullRequest: PullRequestSnapshot;
  diff: string;
  shippedIssues: ProjectCompletionIssue[];
  artifactDir: string;
}

export interface ProjectReviewerRunner {
  reviewProject(context: ProjectReviewContext): Promise<PrReviewResult>;
}

export interface ProjectCompletionCoordinatorTrigger {
  project: ProjectConfig;
  canonicalRuns: RunRecord[];
  triggerRunId: string | null;
}

export type ProjectCompletionRetryOutcome =
  | { outcome: "retried"; completion: ProjectCompletionRecord }
  | { outcome: "no_completion" }
  | { outcome: "lease_held"; completion: ProjectCompletionRecord }
  | { outcome: "not_retryable"; completion: ProjectCompletionRecord };

export interface ProjectCompletionCoordinator {
  startOrResume(trigger: ProjectCompletionCoordinatorTrigger): Promise<ProjectCompletionRecord>;
  retry(project: ProjectConfig): Promise<ProjectCompletionRetryOutcome>;
}

export type PrReviewPostResult =
  | { outcome: "posted"; reviewUrl: string }
  | { outcome: "post_failed"; summary: string };

export interface GhPrReviewPoster {
  post(pullRequest: PullRequestSnapshot, review: PrReviewResult): Promise<PrReviewPostResult>;
}

export interface WorkflowEngineOptions {
  registry: ProjectConfigRegistry;
  linear: LinearWorkflowClient;
  worktrees: WorktreeManager;
  builder: BuilderRunner;
  reviewer: ReviewerRunner;
  store?: WorkflowRunStore;
  completionStore?: ProjectCompletionStore;
  artifacts?: ArtifactWriter;
  logger?: EngineLogger;
  pullRequests?: PullRequestCreator;
  projectCompletionCoordinator?: ProjectCompletionCoordinator;
  onProjectComplete?: (result: ProjectCompletionResult) => void;
  newId?: () => string;
  now?: () => string;
}
