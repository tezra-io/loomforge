export const schemaVersion = 1;

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

CREATE INDEX IF NOT EXISTS runs_project_state_idx ON runs(project_slug, state);
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(queue_position) WHERE queue_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_run_created_idx ON events(run_id, created_at);
`;
