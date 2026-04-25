import type { DatabaseSync } from "node:sqlite";

import type { ReviewFinding } from "../workflow/types.js";
import type {
  DesignFailureReason,
  DesignRequirement,
  DesignReviewOutcome,
  DesignRunKind,
  DesignRunRecord,
  DesignRunState,
  DesignRunStore,
} from "./types.js";

type Row = Record<string, unknown>;

const ACTIVE_STATES: DesignRunState[] = [
  "queued",
  "validating",
  "scaffolding",
  "drafting",
  "reviewing",
  "revising",
  "publishing",
  "registering",
];

export class SqliteDesignRunStore implements DesignRunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  upsert(run: DesignRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO design_runs (
          id, slug, feature, kind, state,
          created_at, updated_at,
          requirement_source, requirement_ref,
          repo_path, remote_url,
          design_doc_path, design_doc_sha,
          linear_project_id, linear_project_url,
          linear_document_id, linear_document_url,
          review_outcome, review_findings_json,
          revision_applied, registered_at,
          failure_reason, queue_position, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          feature = excluded.feature,
          kind = excluded.kind,
          state = excluded.state,
          updated_at = excluded.updated_at,
          requirement_source = excluded.requirement_source,
          requirement_ref = excluded.requirement_ref,
          repo_path = excluded.repo_path,
          remote_url = excluded.remote_url,
          design_doc_path = excluded.design_doc_path,
          design_doc_sha = excluded.design_doc_sha,
          linear_project_id = excluded.linear_project_id,
          linear_project_url = excluded.linear_project_url,
          linear_document_id = excluded.linear_document_id,
          linear_document_url = excluded.linear_document_url,
          review_outcome = excluded.review_outcome,
          review_findings_json = excluded.review_findings_json,
          revision_applied = excluded.revision_applied,
          registered_at = excluded.registered_at,
          failure_reason = excluded.failure_reason,
          queue_position = excluded.queue_position,
          completed_at = excluded.completed_at`,
      )
      .run(
        run.id,
        run.slug,
        run.feature,
        run.kind,
        run.state,
        run.createdAt,
        run.updatedAt,
        run.requirement.source,
        run.requirement.ref,
        run.repoPath,
        run.remoteUrl,
        run.designDocPath,
        run.designDocSha,
        run.linearProjectId,
        run.linearProjectUrl,
        run.linearDocumentId,
        run.linearDocumentUrl,
        run.reviewOutcome,
        run.reviewFindings ? JSON.stringify(run.reviewFindings) : null,
        run.revisionApplied ? 1 : 0,
        run.registeredAt,
        run.failureReason,
        run.queuePosition,
        run.completedAt,
      );
  }

  listQueued(): DesignRunRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM design_runs WHERE queue_position IS NOT NULL ORDER BY queue_position ASC",
      )
      .all()
      .map((row) => toRecord(row as Row));
  }

  getById(id: string): DesignRunRecord | null {
    const row = this.db.prepare("SELECT * FROM design_runs WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : null;
  }

  getByKey(slug: string, feature: string | null): DesignRunRecord | null {
    const sql =
      feature === null
        ? "SELECT * FROM design_runs WHERE slug = ? AND feature IS NULL"
        : "SELECT * FROM design_runs WHERE slug = ? AND feature = ?";
    const stmt = this.db.prepare(sql);
    const row = (feature === null ? stmt.get(slug) : stmt.get(slug, feature)) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  listActive(): DesignRunRecord[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM design_runs WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...ACTIVE_STATES)
      .map((row) => toRecord(row as Row));
  }

  list(): DesignRunRecord[] {
    return this.db
      .prepare("SELECT * FROM design_runs ORDER BY created_at ASC")
      .all()
      .map((row) => toRecord(row as Row));
  }
}

function toRecord(row: Row): DesignRunRecord {
  return {
    id: readString(row, "id"),
    slug: readString(row, "slug"),
    feature: readNullableString(row, "feature"),
    kind: readString(row, "kind") as DesignRunKind,
    state: readString(row, "state") as DesignRunState,
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
    requirement: readRequirement(row),
    repoPath: readNullableString(row, "repo_path"),
    remoteUrl: readNullableString(row, "remote_url"),
    designDocPath: readNullableString(row, "design_doc_path"),
    designDocSha: readNullableString(row, "design_doc_sha"),
    linearProjectId: readNullableString(row, "linear_project_id"),
    linearProjectUrl: readNullableString(row, "linear_project_url"),
    linearDocumentId: readNullableString(row, "linear_document_id"),
    linearDocumentUrl: readNullableString(row, "linear_document_url"),
    reviewOutcome: readNullableString(row, "review_outcome") as DesignReviewOutcome | null,
    reviewFindings: readFindings(row),
    revisionApplied: readNumber(row, "revision_applied") !== 0,
    registeredAt: readNullableNumber(row, "registered_at"),
    failureReason: readNullableString(row, "failure_reason") as DesignFailureReason | null,
    queuePosition: readNullableNumber(row, "queue_position"),
    completedAt: readNullableNumber(row, "completed_at"),
  };
}

function readRequirement(row: Row): DesignRequirement {
  const source = readString(row, "requirement_source");
  if (source !== "path" && source !== "text") {
    throw new Error(`Unexpected requirement_source: ${source}`);
  }
  return { source, ref: readString(row, "requirement_ref") };
}

function readFindings(row: Row): ReviewFinding[] | null {
  const raw = readNullableString(row, "review_findings_json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isFinding);
  } catch {
    return null;
  }
}

function isFinding(value: unknown): value is ReviewFinding {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["severity"] === "string" &&
    ["P0", "P1", "P2"].includes(obj["severity"]) &&
    typeof obj["title"] === "string" &&
    typeof obj["detail"] === "string"
  );
}

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }
  return value;
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Expected nullable string column: ${key}`);
  }
  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Expected number column: ${key}`);
}

function readNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Expected nullable number column: ${key}`);
}
