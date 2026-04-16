import type { ProjectConfig, ProjectConfigRegistry } from "../config/index.js";

export type ExecutionMode = "run_now_if_idle" | "enqueue";

export type RunState =
  | "queued"
  | "preparing_workspace"
  | "building"
  | "verifying"
  | "reviewing"
  | "revising"
  | "ready_for_ship"
  | "shipped"
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
  | "env_failure";

export type CancelReason = "operator_cancel" | "daemon_shutdown";
export type FailureReason = FailedReason | BlockedReason | CancelReason;

export interface SubmitRunInput {
  projectSlug: string;
  issueId: string;
  executionMode: ExecutionMode;
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
  outcome: "success" | "failed" | "blocked";
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
  failureReason?: "verification_failed" | "env_failure";
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
  type: "state_transition" | "attempt_created" | "revision_requested";
  state: RunState;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface RunHandoff {
  version: 1;
  runId: string;
  status: RunState;
  worktreePath: string;
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

export interface LinearWorkflowClient {
  fetchIssue(project: ProjectConfig, issueId: string): Promise<IssueSnapshot>;
  updateIssueStatus(
    project: ProjectConfig,
    issue: IssueSnapshot,
    statusName: string,
  ): Promise<void>;
}

export interface WorktreeManager {
  prepareWorkspace(project: ProjectConfig, issue: IssueSnapshot): Promise<PrepareWorkspaceResult>;
}

export interface BuilderRunner {
  build(context: WorkflowStepContext): Promise<BuilderResult>;
  push(context: PushContext): Promise<PushResult>;
}

export interface VerificationRunner {
  verify(context: WorkflowStepContext): Promise<VerificationResult>;
}

export interface ReviewerRunner {
  review(context: WorkflowStepContext): Promise<ReviewResult>;
}

export interface WorkflowRunStore {
  saveProject(project: ProjectConfig): void;
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | null;
  listRecoverableRuns(): RunRecord[];
}

export interface WorkflowEngineOptions {
  registry: ProjectConfigRegistry;
  linear: LinearWorkflowClient;
  worktrees: WorktreeManager;
  builder: BuilderRunner;
  verifier: VerificationRunner;
  reviewer: ReviewerRunner;
  store?: WorkflowRunStore;
  newId?: () => string;
  now?: () => string;
}
