import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProjectConfig } from "../config/index.js";
import { parseRunHandoff } from "../artifacts/handoff.js";
import type {
  BuilderResult,
  IssueSnapshot,
  ReviewResult,
  RunAttemptRecord,
  RunEvent,
  RunHandoff,
  RunRecord,
  RunState,
  VerificationResult,
  WorkflowRunStore,
  WorkspaceSnapshot,
} from "../workflow/index.js";
import { schemaVersion, sqliteSchema } from "./schema.js";

type Row = Record<string, unknown>;

export class SqliteRunStore implements WorkflowRunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.applySchema();
  }

  static open(dbPath: string): SqliteRunStore {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    return new SqliteRunStore(new DatabaseSync(dbPath));
  }

  close(): void {
    this.db.close();
  }

  saveProject(project: ProjectConfig): void {
    this.db
      .prepare(
        `INSERT INTO projects (
          slug, repo_root, default_branch, dev_branch, worktree_root,
          runtime_data_root, config_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          repo_root = excluded.repo_root,
          default_branch = excluded.default_branch,
          dev_branch = excluded.dev_branch,
          worktree_root = excluded.worktree_root,
          runtime_data_root = excluded.runtime_data_root,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        project.slug,
        project.repoRoot,
        project.defaultBranch,
        project.devBranch,
        project.worktreeRoot,
        project.runtimeDataRoot,
        JSON.stringify(project),
        new Date().toISOString(),
      );
  }

  saveRun(run: RunRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertRun(run);
      this.replaceRunChildren(run);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) {
      return null;
    }

    return this.toRun(row);
  }

  listQueuedRuns(): RunRecord[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE queue_position IS NOT NULL ORDER BY queue_position ASC")
      .all()
      .map((row) => this.toRun(row));
  }

  listRecoverableRuns(): RunRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
        WHERE state NOT IN ('shipped', 'blocked', 'failed', 'cancelled')
        ORDER BY queue_position IS NULL, queue_position ASC, updated_at ASC`,
      )
      .all()
      .map((row) => this.toRun(row));
  }

  private applySchema(): void {
    this.db.exec(sqliteSchema);
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(schemaVersion, new Date().toISOString());
  }

  private upsertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, project_slug, issue_id, state, failure_reason, revision_count,
          queue_position, issue_snapshot_json, handoff_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_slug = excluded.project_slug,
          issue_id = excluded.issue_id,
          state = excluded.state,
          failure_reason = excluded.failure_reason,
          revision_count = excluded.revision_count,
          queue_position = excluded.queue_position,
          issue_snapshot_json = excluded.issue_snapshot_json,
          handoff_json = excluded.handoff_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        run.id,
        run.projectSlug,
        run.issueId,
        run.state,
        run.failureReason,
        run.revisionCount,
        run.queuePosition,
        stringifyNullable(run.issueSnapshot),
        stringifyNullable(run.handoff),
        run.createdAt,
        run.updatedAt,
      );
  }

  private replaceRunChildren(run: RunRecord): void {
    this.deleteRunChildren(run.id);
    this.insertWorkspace(run);
    for (const attempt of run.attempts) {
      this.insertAttempt(attempt);
    }
    for (const event of run.events) {
      this.insertEvent(event);
    }
    this.insertHandoffArtifact(run);
  }

  private deleteRunChildren(runId: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM workspaces WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM run_attempts WHERE run_id = ?").run(runId);
  }

  private insertWorkspace(run: RunRecord): void {
    if (!run.workspace) {
      return;
    }

    this.db
      .prepare("INSERT INTO workspaces (run_id, worktree_path, branch_name) VALUES (?, ?, ?)")
      .run(run.id, run.workspace.path, run.workspace.branchName);
  }

  private insertAttempt(attempt: RunAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO run_attempts (
          id, run_id, attempt_number, outcome, builder_result_json,
          verification_result_json, review_result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.attemptNumber,
        attempt.outcome,
        stringifyNullable(attempt.builderResult),
        stringifyNullable(attempt.verificationResult),
        stringifyNullable(attempt.reviewResult),
        attempt.createdAt,
        attempt.updatedAt,
      );
    this.insertVerification(attempt);
    this.insertReview(attempt);
  }

  private insertVerification(attempt: RunAttemptRecord): void {
    if (!attempt.verificationResult) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO verifications (
          id, attempt_id, outcome, summary, raw_log_path, command_results_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${attempt.id}:verification`,
        attempt.id,
        attempt.verificationResult.outcome,
        attempt.verificationResult.summary,
        attempt.verificationResult.rawLogPath,
        JSON.stringify(attempt.verificationResult.commandResults),
      );
  }

  private insertReview(attempt: RunAttemptRecord): void {
    if (!attempt.reviewResult) {
      return;
    }

    const reviewId = `${attempt.id}:review`;
    this.db
      .prepare(
        "INSERT INTO reviews (id, attempt_id, outcome, summary, raw_log_path) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        reviewId,
        attempt.id,
        attempt.reviewResult.outcome,
        attempt.reviewResult.summary,
        attempt.reviewResult.rawLogPath,
      );

    for (const [index, finding] of attempt.reviewResult.findings.entries()) {
      this.db
        .prepare(
          `INSERT INTO review_findings (
            id, review_id, severity, title, detail, file, finding_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${reviewId}:finding:${index + 1}`,
          reviewId,
          finding.severity,
          finding.title,
          finding.detail,
          finding.file ?? null,
          index + 1,
        );
    }
  }

  private insertEvent(event: RunEvent): void {
    this.db
      .prepare(
        "INSERT INTO events (id, run_id, type, state, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.runId,
        event.type,
        event.state,
        event.createdAt,
        JSON.stringify(event.details),
      );
  }

  private insertHandoffArtifact(run: RunRecord): void {
    if (!run.handoff) {
      return;
    }

    this.db
      .prepare(
        "INSERT INTO artifacts (id, run_id, kind, path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `${run.id}:handoff`,
        run.id,
        "handoff",
        `${run.id}/handoff.json`,
        JSON.stringify({ version: run.handoff.version }),
        run.updatedAt,
      );
  }

  private toRun(row: Row): RunRecord {
    const runId = readString(row, "id");
    return {
      id: runId,
      projectSlug: readString(row, "project_slug"),
      issueId: readString(row, "issue_id"),
      state: readString(row, "state") as RunState,
      failureReason: readNullableString(row, "failure_reason") as RunRecord["failureReason"],
      revisionCount: readNumber(row, "revision_count"),
      queuePosition: readNullableNumber(row, "queue_position"),
      issueSnapshot: readJson<IssueSnapshot>(row, "issue_snapshot_json"),
      workspace: this.readWorkspace(runId),
      attempts: this.readAttempts(runId),
      events: this.readEvents(runId),
      handoff: this.readHandoff(row),
      createdAt: readString(row, "created_at"),
      updatedAt: readString(row, "updated_at"),
    };
  }

  private readWorkspace(runId: string): WorkspaceSnapshot | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE run_id = ?").get(runId);
    if (!row) {
      return null;
    }

    return {
      path: readString(row, "worktree_path"),
      branchName: readString(row, "branch_name"),
    };
  }

  private readAttempts(runId: string): RunAttemptRecord[] {
    return this.db
      .prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_number ASC")
      .all(runId)
      .map((row) => ({
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        attemptNumber: readNumber(row, "attempt_number"),
        outcome: readNullableString(row, "outcome"),
        builderResult: readJson<BuilderResult>(row, "builder_result_json"),
        verificationResult: readJson<VerificationResult>(row, "verification_result_json"),
        reviewResult: readJson<ReviewResult>(row, "review_result_json"),
        createdAt: readString(row, "created_at"),
        updatedAt: readString(row, "updated_at"),
      }));
  }

  private readEvents(runId: string): RunEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId)
      .map((row) => ({
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        type: readString(row, "type") as RunEvent["type"],
        state: readString(row, "state") as RunState,
        createdAt: readString(row, "created_at"),
        details: readJson<Record<string, unknown>>(row, "details_json") ?? {},
      }));
  }

  private readHandoff(row: Row): RunHandoff | null {
    const raw = readNullableString(row, "handoff_json");
    if (!raw) {
      return null;
    }

    return parseRunHandoff(JSON.parse(raw));
  }
}

function stringifyNullable(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
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
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected nullable string column: ${key}`);
  }
  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected number column: ${key}`);
  }
  return value;
}

function readNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`Expected nullable number column: ${key}`);
  }
  return value;
}

function readJson<T>(row: Row, key: string): T | null {
  const raw = readNullableString(row, key);
  return raw ? (JSON.parse(raw) as T) : null;
}
