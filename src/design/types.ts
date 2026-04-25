import type { ReviewFinding } from "../workflow/types.js";

export type DesignRunKind = "new" | "extend";

export type DesignRunState =
  | "queued"
  | "validating"
  | "scaffolding"
  | "drafting"
  | "reviewing"
  | "revising"
  | "publishing"
  | "registering"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled";

export const DESIGN_TERMINAL_STATES: ReadonlyArray<DesignRunState> = [
  "complete",
  "failed",
  "blocked",
  "cancelled",
];

export function isDesignTerminalState(state: DesignRunState): boolean {
  return DESIGN_TERMINAL_STATES.includes(state);
}

export type DesignReviewOutcome = "pass" | "revise" | "blocked";

export type DesignFailureReason =
  | "invalid_input"
  | "scaffolding_failed"
  | "runner_error"
  | "runner_auth_missing"
  | "design_empty_output"
  | "design_review_blocked"
  | "linear_team_missing"
  | "design_linear_conflict"
  | "design_document_conflict"
  | "registration_failed"
  | "timeout"
  | "project_not_found"
  | "operator_cancel"
  | "daemon_shutdown";

export type DesignExecutionMode = "run_now_if_idle" | "enqueue";

export interface DesignRequirement {
  source: "path" | "text";
  ref: string;
}

export interface DesignRunRecord {
  id: string;
  slug: string;
  feature: string | null;
  kind: DesignRunKind;
  state: DesignRunState;
  createdAt: number;
  updatedAt: number;
  requirement: DesignRequirement;
  repoPath: string | null;
  remoteUrl: string | null;
  designDocPath: string | null;
  designDocSha: string | null;
  linearProjectId: string | null;
  linearProjectUrl: string | null;
  linearDocumentId: string | null;
  linearDocumentUrl: string | null;
  reviewOutcome: DesignReviewOutcome | null;
  reviewFindings: ReviewFinding[] | null;
  revisionApplied: boolean;
  registeredAt: number | null;
  failureReason: DesignFailureReason | null;
  queuePosition: number | null;
  completedAt: number | null;
}

export interface DesignRunStore {
  upsert(run: DesignRunRecord): void;
  getById(id: string): DesignRunRecord | null;
  getByKey(slug: string, feature: string | null): DesignRunRecord | null;
  listActive(): DesignRunRecord[];
  listQueued(): DesignRunRecord[];
  list(): DesignRunRecord[];
}

export interface DesignNewInput {
  slug: string;
  requirementPath?: string;
  requirementText?: string;
  repoRoot?: string;
  redraft?: boolean;
}

export interface DesignExtendInput {
  slug: string;
  feature: string;
  requirementPath?: string;
  requirementText?: string;
  redraft?: boolean;
}

export interface DesignHandoff {
  version: 1;
  designRunId: string;
  kind: DesignRunKind;
  slug: string;
  feature: string | null;
  state: DesignRunState;
  localDocPath: string | null;
  linearProjectUrl: string | null;
  linearDocumentUrl: string | null;
  registration: "registered" | "needs_remote" | "needs_registration" | "skipped";
  notes: string[];
  failureReason: DesignFailureReason | null;
}
