import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";

import { SqliteRunStore } from "../src/db/sqlite-run-store.js";

const v1Schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  dev_branch TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  runtime_data_root TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL,
  failure_reason TEXT,
  revision_count INTEGER NOT NULL,
  queue_position INTEGER,
  issue_snapshot_json TEXT,
  handoff_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_slug) REFERENCES projects(slug)
);

CREATE TABLE IF NOT EXISTS workspaces (
  run_id TEXT PRIMARY KEY,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome TEXT,
  builder_result_json TEXT,
  verification_result_json TEXT,
  review_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  UNIQUE (run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_log_path TEXT NOT NULL,
  command_results_json TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES run_attempts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_log_path TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES run_attempts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  file TEXT,
  finding_order INTEGER NOT NULL,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
`;

describe("v1 to v2 schema migration", () => {
  it("migrates a v1 database with existing data", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(v1Schema);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO projects (slug, repo_root, default_branch, dev_branch, worktree_root, runtime_data_root, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test",
      "/repos/test",
      "main",
      "dev",
      "/worktrees/test",
      "/data/test",
      "{}",
      "2026-01-01",
    );

    const handoff = JSON.stringify({ version: 1, worktreePath: "/worktrees/test" });
    db.prepare(
      `INSERT INTO runs (id, project_slug, issue_id, state, failure_reason, revision_count, queue_position, issue_snapshot_json, handoff_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      "test",
      "TEZ-1",
      "shipped",
      null,
      0,
      null,
      null,
      handoff,
      "2026-01-01",
      "2026-01-01",
    );

    db.prepare("INSERT INTO workspaces (run_id, worktree_path, branch_name) VALUES (?, ?, ?)").run(
      "run-1",
      "/worktrees/test/run-1",
      "dev",
    );

    const store = new SqliteRunStore(db);

    store.saveProject({
      slug: "test2",
      repoRoot: "/repos/test2",
      defaultBranch: "main",
      devBranch: "dev",
      linearTeamKey: null,
      linearProjectName: null,
      builder: "claude",
      reviewer: "claude",
      runtimeDataRoot: "/data/test2",
      verification: { commands: [{ name: "test", command: "echo ok", timeoutMs: 10_000 }] },
      timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
      review: { maxRevisionLoops: 3, blockingSeverities: ["P0", "P1"] },
      linearStatuses: {
        inProgress: "In Progress",
        inReview: "In Review",
        done: "Done",
        blocked: "Blocked",
      },
    });

    const projects = db.prepare("SELECT * FROM projects ORDER BY slug").all() as Record<
      string,
      unknown
    >[];
    expect(projects).toHaveLength(2);
    expect(projects[0]).not.toHaveProperty("worktree_root");
    expect(projects[0]).toHaveProperty("runtime_data_root");

    const workspaces = db.prepare("SELECT * FROM workspaces").all() as Record<string, unknown>[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toHaveProperty("workspace_path", "/worktrees/test/run-1");
    expect(workspaces[0]).not.toHaveProperty("worktree_path");

    const runs = db.prepare("SELECT handoff_json FROM runs WHERE id = ?").get("run-1") as Record<
      string,
      unknown
    >;
    const migratedHandoff = JSON.parse(runs["handoff_json"] as string);
    expect(migratedHandoff).toHaveProperty("workspacePath");
    expect(migratedHandoff).not.toHaveProperty("worktreePath");

    store.close();
  });

  it("opens a fresh database without errors", () => {
    const store = SqliteRunStore.open(":memory:");
    store.close();
  });
});

function seedV5Schema(db: DatabaseSync): void {
  const statements: string[] = [
    `CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE projects (
      slug TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      dev_branch TEXT NOT NULL,
      runtime_data_root TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      state TEXT NOT NULL,
      failure_reason TEXT,
      revision_count INTEGER NOT NULL,
      queue_position INTEGER,
      issue_snapshot_json TEXT,
      handoff_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_slug) REFERENCES projects(slug)
    )`,
  ];
  for (const stmt of statements) {
    db.prepare(stmt).run();
  }
}

describe("v5 to v6 schema migration", () => {
  it("adds runs.source with default 'linear' and backfills existing rows", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Schema(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      5,
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO projects (slug, repo_root, default_branch, dev_branch, runtime_data_root, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("demo", "/repos/demo", "main", "dev", "/data", "{}", "2026-04-25T00:00:00.000Z");

    db.prepare(
      `INSERT INTO runs (id, project_slug, issue_id, state, failure_reason, revision_count, queue_position, issue_snapshot_json, handoff_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      "demo",
      "TEZ-1",
      "queued",
      null,
      0,
      1,
      null,
      null,
      "2026-04-25T00:00:00.000Z",
      "2026-04-25T00:00:00.000Z",
    );

    const store = new SqliteRunStore(db);

    const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "source")).toBe(true);

    const row = db.prepare("SELECT id, source FROM runs WHERE id = ?").get("run-1") as
      | { id: string; source: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.source).toBe("linear");

    store.close();
  });
});
