export const schemaVersion = 5;

export interface SchemaMigration {
  version: number;
  sql: string;
  needsCheck?: boolean;
  checkColumn?: { table: string; column: string };
  skipIfColumnExists?: { table: string; column: string };
  disableForeignKeys?: boolean;
}

export const migrations: SchemaMigration[] = [
  {
    version: 2,
    needsCheck: true,
    checkColumn: { table: "projects", column: "worktree_root" },
    disableForeignKeys: true,
    sql: `
-- Drop worktree_root from projects (SQLite requires table rebuild)
CREATE TABLE projects_v2 (
  slug TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  dev_branch TEXT NOT NULL,
  runtime_data_root TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO projects_v2 (slug, repo_root, default_branch, dev_branch, runtime_data_root, config_json, updated_at)
  SELECT slug, repo_root, default_branch, dev_branch, runtime_data_root, config_json, updated_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v2 RENAME TO projects;

-- Rename worktree_path to workspace_path in workspaces
CREATE TABLE workspaces_v2 (
  run_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
INSERT INTO workspaces_v2 (run_id, workspace_path, branch_name)
  SELECT run_id, worktree_path, branch_name FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_v2 RENAME TO workspaces;

-- Migrate handoff JSON: rename worktreePath to workspacePath
UPDATE runs SET handoff_json = REPLACE(handoff_json, '"worktreePath"', '"workspacePath"')
  WHERE handoff_json IS NOT NULL AND handoff_json LIKE '%worktreePath%';
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS design_runs (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL,
  feature                TEXT,
  kind                   TEXT NOT NULL,
  state                  TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  requirement_source     TEXT NOT NULL,
  requirement_ref        TEXT NOT NULL,
  repo_path              TEXT,
  remote_url             TEXT,
  design_doc_path        TEXT,
  design_doc_sha         TEXT,
  linear_project_id      TEXT,
  linear_document_id     TEXT,
  review_outcome         TEXT,
  review_findings_json   TEXT,
  failure_reason         TEXT,
  completed_at           INTEGER,
  UNIQUE (slug, feature)
);

CREATE INDEX IF NOT EXISTS design_runs_state_idx ON design_runs(state);
`,
  },
  {
    version: 4,
    skipIfColumnExists: { table: "design_runs", column: "linear_project_url" },
    sql: `
ALTER TABLE design_runs ADD COLUMN linear_project_url TEXT;
ALTER TABLE design_runs ADD COLUMN linear_document_url TEXT;
ALTER TABLE design_runs ADD COLUMN queue_position INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS design_runs_slug_null_feature_uq
  ON design_runs(slug) WHERE feature IS NULL;
CREATE INDEX IF NOT EXISTS design_runs_queue_idx
  ON design_runs(queue_position) WHERE queue_position IS NOT NULL;
`,
  },
  {
    version: 5,
    skipIfColumnExists: { table: "design_runs", column: "revision_applied" },
    sql: `
ALTER TABLE design_runs ADD COLUMN revision_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE design_runs ADD COLUMN registered_at INTEGER;
`,
  },
];

export const sqliteSchema = `
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
  workspace_path TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS design_runs (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL,
  feature                TEXT,
  kind                   TEXT NOT NULL,
  state                  TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  requirement_source     TEXT NOT NULL,
  requirement_ref        TEXT NOT NULL,
  repo_path              TEXT,
  remote_url             TEXT,
  design_doc_path        TEXT,
  design_doc_sha         TEXT,
  linear_project_id      TEXT,
  linear_project_url     TEXT,
  linear_document_id     TEXT,
  linear_document_url    TEXT,
  review_outcome         TEXT,
  review_findings_json   TEXT,
  revision_applied       INTEGER NOT NULL DEFAULT 0,
  registered_at          INTEGER,
  failure_reason         TEXT,
  queue_position         INTEGER,
  completed_at           INTEGER,
  UNIQUE (slug, feature)
);

CREATE INDEX IF NOT EXISTS runs_project_state_idx ON runs(project_slug, state);
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(queue_position) WHERE queue_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_run_created_idx ON events(run_id, created_at);
CREATE INDEX IF NOT EXISTS design_runs_state_idx ON design_runs(state);
CREATE UNIQUE INDEX IF NOT EXISTS design_runs_slug_null_feature_uq
  ON design_runs(slug) WHERE feature IS NULL;
CREATE INDEX IF NOT EXISTS design_runs_queue_idx
  ON design_runs(queue_position) WHERE queue_position IS NOT NULL;
`;
