import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProjectConfig } from "../config/index.js";
import { parseRunHandoff } from "../artifacts/handoff.js";
import type {
  BuilderResult,
  CreateProjectCompletionInput,
  IssueSnapshot,
  PrReviewOutcome,
  PrReviewResult,
  ProjectArtifactRecord,
  ProjectCompletionFailureReason,
  ProjectCompletionIssue,
  ProjectCompletionRecord,
  ProjectCompletionState,
  ProjectCompletionStore,
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
import { migrations, schemaVersion, sqliteSchema } from "./schema.js";

type Row = Record<string, unknown>;

export class SqliteRunStore implements WorkflowRunStore, ProjectCompletionStore {
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

  rawDb(): DatabaseSync {
    return this.db;
  }

  saveProject(project: ProjectConfig): void {
    this.db
      .prepare(
        `INSERT INTO projects (
          slug, repo_root, default_branch, dev_branch,
          runtime_data_root, config_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          repo_root = excluded.repo_root,
          default_branch = excluded.default_branch,
          dev_branch = excluded.dev_branch,
          runtime_data_root = excluded.runtime_data_root,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        project.slug,
        project.repoRoot,
        project.defaultBranch,
        project.devBranch,
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

  saveArtifact(artifact: {
    id: string;
    runId: string;
    kind: string;
    path: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO artifacts (id, run_id, kind, path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.path,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      );
  }

  listArtifacts(runId: string): Array<{
    id: string;
    runId: string;
    kind: string;
    path: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }> {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId)
      .map((row) => ({
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        kind: readString(row, "kind"),
        path: readString(row, "path"),
        metadata: readJson<Record<string, unknown>>(row, "metadata_json") ?? {},
        createdAt: readString(row, "created_at"),
      }));
  }

  listRecoverableRuns(): RunRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
        WHERE state NOT IN ('shipped', 'already_complete', 'blocked', 'failed', 'cancelled')
        ORDER BY queue_position IS NULL, queue_position ASC, updated_at ASC`,
      )
      .all()
      .map((row) => this.toRun(row));
  }

  createOrResumeProjectCompletion(input: CreateProjectCompletionInput): ProjectCompletionRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findActiveCompletionRow(input.projectSlug);
      if (existing) {
        this.db.exec("COMMIT");
        return this.toProjectCompletion(existing);
      }

      const record = newProjectCompletionRecord(input);
      this.insertProjectCompletion(record);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateProjectCompletion(record: ProjectCompletionRecord): void {
    this.db
      .prepare(
        `UPDATE project_completions SET
          state = ?,
          failure_reason = ?,
          pr_url = ?,
          pr_number = ?,
          base_branch = ?,
          dev_branch = ?,
          base_sha = ?,
          dev_sha = ?,
          shipped_issues_json = ?,
          already_complete_issue_ids_json = ?,
          failed_issue_ids_json = ?,
          blocked_issue_ids_json = ?,
          cancelled_issue_ids_json = ?,
          review_result_json = ?,
          pr_review_outcome = ?,
          pr_review_url = ?,
          finding_counts_json = ?,
          post_pr_review_comments = ?,
          blocking_severities_json = ?,
          review_partial_pr = ?,
          updated_at = ?,
          completed_at = ?
        WHERE id = ?`,
      )
      .run(
        record.state,
        record.failureReason,
        record.prUrl,
        record.prNumber,
        record.baseBranch,
        record.devBranch,
        record.baseSha,
        record.devSha,
        JSON.stringify(record.shippedIssues),
        JSON.stringify(record.alreadyCompleteIssueIds),
        JSON.stringify(record.failedIssueIds),
        JSON.stringify(record.blockedIssueIds),
        JSON.stringify(record.cancelledIssueIds),
        stringifyNullable(record.reviewResult),
        record.prReviewOutcome,
        record.prReviewUrl,
        JSON.stringify(record.findingCounts),
        record.postPrReviewComments ? 1 : 0,
        JSON.stringify(record.blockingSeverities),
        record.reviewPartialPr ? 1 : 0,
        record.updatedAt,
        record.completedAt,
        record.id,
      );
  }

  getProjectCompletion(id: string): ProjectCompletionRecord | null {
    const row = this.db.prepare("SELECT * FROM project_completions WHERE id = ?").get(id);
    return row ? this.toProjectCompletion(row) : null;
  }

  getLatestProjectCompletion(projectSlug: string): ProjectCompletionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM project_completions
         WHERE project_slug = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(projectSlug);
    return row ? this.toProjectCompletion(row) : null;
  }

  listActiveProjectCompletions(): ProjectCompletionRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM project_completions
         WHERE state IN ('pending', 'creating_pr', 'reviewing')
         ORDER BY created_at ASC`,
      )
      .all()
      .map((row) => this.toProjectCompletion(row));
  }

  releaseProjectCompletionLease(completionId: string, ownerId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE project_completions
         SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND lease_owner = ?`,
      )
      .run(now, completionId, ownerId);
  }

  acquireProjectCompletionLease(
    completionId: string,
    ownerId: string,
    expiresAt: string,
    now: string,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT lease_owner, lease_expires_at FROM project_completions
           WHERE id = ?`,
        )
        .get(completionId) as
        | { lease_owner: string | null; lease_expires_at: string | null }
        | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const heldByOther =
        row.lease_owner !== null &&
        row.lease_owner !== ownerId &&
        row.lease_expires_at !== null &&
        row.lease_expires_at > now;
      if (heldByOther) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE project_completions
           SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(ownerId, expiresAt, now, completionId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveProjectArtifact(artifact: ProjectArtifactRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO project_artifacts (
          id, completion_id, kind, path, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.completionId,
        artifact.kind,
        artifact.path,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      );
  }

  listProjectArtifacts(completionId: string): ProjectArtifactRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM project_artifacts
         WHERE completion_id = ?
         ORDER BY created_at ASC`,
      )
      .all(completionId)
      .map((row) => ({
        id: readString(row, "id"),
        completionId: readString(row, "completion_id"),
        kind: readString(row, "kind"),
        path: readString(row, "path"),
        metadata: readJson<Record<string, unknown>>(row, "metadata_json") ?? {},
        createdAt: readString(row, "created_at"),
      }));
  }

  private findActiveCompletionRow(projectSlug: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM project_completions
         WHERE project_slug = ?
           AND state IN ('pending', 'creating_pr', 'reviewing')
         LIMIT 1`,
      )
      .get(projectSlug);
    return (row as Row | undefined) ?? null;
  }

  private insertProjectCompletion(record: ProjectCompletionRecord): void {
    this.db
      .prepare(
        `INSERT INTO project_completions (
          id, project_slug, state, failure_reason, pr_url, pr_number,
          base_branch, dev_branch, base_sha, dev_sha,
          shipped_issues_json, already_complete_issue_ids_json,
          failed_issue_ids_json, blocked_issue_ids_json, cancelled_issue_ids_json,
          review_result_json, pr_review_outcome, pr_review_url,
          finding_counts_json, post_pr_review_comments,
          blocking_severities_json, review_partial_pr,
          lease_owner, lease_expires_at, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectSlug,
        record.state,
        record.failureReason,
        record.prUrl,
        record.prNumber,
        record.baseBranch,
        record.devBranch,
        record.baseSha,
        record.devSha,
        JSON.stringify(record.shippedIssues),
        JSON.stringify(record.alreadyCompleteIssueIds),
        JSON.stringify(record.failedIssueIds),
        JSON.stringify(record.blockedIssueIds),
        JSON.stringify(record.cancelledIssueIds),
        stringifyNullable(record.reviewResult),
        record.prReviewOutcome,
        record.prReviewUrl,
        JSON.stringify(record.findingCounts),
        record.postPrReviewComments ? 1 : 0,
        JSON.stringify(record.blockingSeverities),
        record.reviewPartialPr ? 1 : 0,
        record.leaseOwner,
        record.leaseExpiresAt,
        record.createdAt,
        record.updatedAt,
        record.completedAt,
      );
  }

  private toProjectCompletion(row: Row): ProjectCompletionRecord {
    return {
      id: readString(row, "id"),
      projectSlug: readString(row, "project_slug"),
      state: readString(row, "state") as ProjectCompletionState,
      failureReason: readNullableString(
        row,
        "failure_reason",
      ) as ProjectCompletionFailureReason | null,
      prUrl: readNullableString(row, "pr_url"),
      prNumber: readNullableNumber(row, "pr_number"),
      baseBranch: readString(row, "base_branch"),
      devBranch: readString(row, "dev_branch"),
      baseSha: readNullableString(row, "base_sha"),
      devSha: readNullableString(row, "dev_sha"),
      shippedIssues: readJson<ProjectCompletionIssue[]>(row, "shipped_issues_json") ?? [],
      alreadyCompleteIssueIds: readJson<string[]>(row, "already_complete_issue_ids_json") ?? [],
      failedIssueIds: readJson<string[]>(row, "failed_issue_ids_json") ?? [],
      blockedIssueIds: readJson<string[]>(row, "blocked_issue_ids_json") ?? [],
      cancelledIssueIds: readJson<string[]>(row, "cancelled_issue_ids_json") ?? [],
      reviewResult: readJson<PrReviewResult>(row, "review_result_json"),
      prReviewOutcome: readNullableString(row, "pr_review_outcome") as PrReviewOutcome | null,
      prReviewUrl: readNullableString(row, "pr_review_url"),
      findingCounts: readJson<{ p0: number; p1: number; p2: number }>(
        row,
        "finding_counts_json",
      ) ?? { p0: 0, p1: 0, p2: 0 },
      postPrReviewComments: readNumber(row, "post_pr_review_comments") === 1,
      blockingSeverities:
        readJson<Array<"P0" | "P1" | "P2">>(row, "blocking_severities_json") ?? [],
      reviewPartialPr: readNumber(row, "review_partial_pr") === 1,
      leaseOwner: readNullableString(row, "lease_owner"),
      leaseExpiresAt: readNullableString(row, "lease_expires_at"),
      createdAt: readString(row, "created_at"),
      updatedAt: readString(row, "updated_at"),
      completedAt: readNullableString(row, "completed_at"),
    };
  }

  private applySchema(): void {
    this.db.exec(sqliteSchema);
    const currentVersion = this.getCurrentSchemaVersion();
    this.applyMigrations(currentVersion);
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(schemaVersion, new Date().toISOString());
  }

  private getCurrentSchemaVersion(): number {
    try {
      const row = this.db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as
        | Row
        | undefined;
      if (!row || row["version"] === null || row["version"] === undefined) {
        return 0;
      }
      return readNumber(row, "version");
    } catch {
      return 0;
    }
  }

  private applyMigrations(currentVersion: number): void {
    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }
      if (migration.needsCheck && migration.checkColumn) {
        if (!this.columnExists(migration.checkColumn.table, migration.checkColumn.column)) {
          this.db
            .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
          continue;
        }
      }
      if (migration.skipIfColumnExists) {
        const { table, column } = migration.skipIfColumnExists;
        if (this.columnExists(table, column)) {
          this.db
            .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
          continue;
        }
      }
      if (migration.disableForeignKeys) {
        this.db.exec("PRAGMA foreign_keys = OFF");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`Schema migration to v${migration.version} failed`, { cause: error });
      } finally {
        if (migration.disableForeignKeys) {
          this.db.exec("PRAGMA foreign_keys = ON");
        }
      }
    }
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return rows.some((row) => row["name"] === column);
  }

  private upsertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, project_slug, issue_id, state, failure_reason, revision_count,
          queue_position, issue_snapshot_json, handoff_json, source,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_slug = excluded.project_slug,
          issue_id = excluded.issue_id,
          state = excluded.state,
          failure_reason = excluded.failure_reason,
          revision_count = excluded.revision_count,
          queue_position = excluded.queue_position,
          issue_snapshot_json = excluded.issue_snapshot_json,
          handoff_json = excluded.handoff_json,
          source = excluded.source,
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
        run.source,
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
  }

  private deleteRunChildren(runId: string): void {
    this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM workspaces WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM run_attempts WHERE run_id = ?").run(runId);
  }

  private insertWorkspace(run: RunRecord): void {
    if (!run.workspace) {
      return;
    }

    this.db
      .prepare("INSERT INTO workspaces (run_id, workspace_path, branch_name) VALUES (?, ?, ?)")
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

  private toRun(row: Row): RunRecord {
    const runId = readString(row, "id");
    const sourceValue = row["source"];
    const source: RunRecord["source"] = sourceValue === "adhoc" ? "adhoc" : "linear";
    return {
      id: runId,
      projectSlug: readString(row, "project_slug"),
      issueId: readString(row, "issue_id"),
      source,
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
      path: readString(row, "workspace_path"),
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

function newProjectCompletionRecord(input: CreateProjectCompletionInput): ProjectCompletionRecord {
  return {
    id: input.id,
    projectSlug: input.projectSlug,
    state: "pending",
    failureReason: null,
    prUrl: null,
    prNumber: null,
    baseBranch: input.baseBranch,
    devBranch: input.devBranch,
    baseSha: null,
    devSha: null,
    shippedIssues: input.shippedIssues,
    alreadyCompleteIssueIds: input.alreadyCompleteIssueIds,
    failedIssueIds: input.failedIssueIds,
    blockedIssueIds: input.blockedIssueIds,
    cancelledIssueIds: input.cancelledIssueIds,
    reviewResult: null,
    prReviewOutcome: null,
    prReviewUrl: null,
    findingCounts: { p0: 0, p1: 0, p2: 0 },
    postPrReviewComments: input.postPrReviewComments,
    blockingSeverities: input.blockingSeverities,
    reviewPartialPr: input.reviewPartialPr,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
  };
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
