# Ad-hoc Prompt Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ad-hoc submission path: caller sends `{ project, prompt }`; Loomforge creates a `loomforge-adhoc`-labeled Linear issue and runs it through the existing build engine.

**Architecture:** Ad-hoc is not a new pipeline. A small orchestrator (`src/workflow/adhoc.ts`) resolves the project, validates Linear preconditions, creates one Linear issue, then calls `engine.submitRun({ source: "adhoc", ... })`. Engine gains a `source` discriminator (DB column + `RunRecord` field). The route, CLI command, and MCP tool are thin wrappers — same pattern as the existing surfaces.

**Tech Stack:** TypeScript, Node 22+, Fastify, Commander, `@modelcontextprotocol/sdk`, `@linear/sdk`, SQLite (`node:sqlite`), zod, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-04-26-adhoc-prompt-runs-design.md`

**Conventions:**
- Each task ends in a single commit. No co-author lines (per repo rule).
- Run `pnpm run typecheck && pnpm run test && pnpm run lint` before each commit. Hard gate.
- Tests use vitest. No machine-absolute paths (`/Users/...`) — use `tmpdir()`, env, or fixtures.
- Commit subjects follow Conventional Commits (`feat(scope): subject`, `fix(scope): subject`, `docs(scope): subject`).

---

## Task 1: DB migration — add `source` column to `runs`

**Files:**
- Modify: `src/db/schema.ts` (add migration v6, update fresh-install schema)
- Test: `tests/db-migration.test.ts` (add a v5→v6 test case)

- [ ] **Step 1: Write the failing test**

Open `tests/db-migration.test.ts`. Add a new `it(...)` inside the existing top-level `describe`:

```typescript
it("migrates from v5 to v6 by adding the runs.source column with default 'linear'", async () => {
  const dbPath = join(await mkdtemp(join(tmpdir(), "loom-mig-v5-")), "loom.db");
  const db = new DatabaseSync(dbPath);

  // Seed the v5-shaped schema and one queued run.
  const seedSql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-04-25T00:00:00.000Z');
    CREATE TABLE projects (
      slug TEXT PRIMARY KEY, repo_root TEXT NOT NULL, default_branch TEXT NOT NULL,
      dev_branch TEXT NOT NULL, runtime_data_root TEXT NOT NULL,
      config_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('demo', '/repos/demo', 'main', 'dev', '/data', '{}', '2026-04-25T00:00:00.000Z');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, issue_id TEXT NOT NULL,
      state TEXT NOT NULL, failure_reason TEXT, revision_count INTEGER NOT NULL,
      queue_position INTEGER, issue_snapshot_json TEXT, handoff_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (project_slug) REFERENCES projects(slug)
    );
    INSERT INTO runs VALUES (
      'run-1', 'demo', 'TEZ-1', 'queued', NULL, 0, 1, NULL, NULL,
      '2026-04-25T00:00:00.000Z', '2026-04-25T00:00:00.000Z'
    );
  `;
  db.exec(seedSql);
  db.close();

  // Open via the store — this triggers migrations to current schemaVersion.
  const store = new SqliteRunStore(dbPath);
  store.close();

  const verify = new DatabaseSync(dbPath);
  const cols = verify.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  expect(cols.some((c) => c.name === "source")).toBe(true);

  const row = verify.prepare("SELECT id, source FROM runs WHERE id = ?").get("run-1") as
    | { id: string; source: string }
    | undefined;
  expect(row).toBeDefined();
  expect(row!.source).toBe("linear");
  verify.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run tests/db-migration.test.ts
```

Expected: FAIL with something like `expect(cols.some(...)).toBe(true)` failing because `source` column does not yet exist.

- [ ] **Step 3: Add migration v6 and update fresh-install schema**

Edit `src/db/schema.ts`:

1. Bump `export const schemaVersion = 5;` → `export const schemaVersion = 6;`.
2. Append to the `migrations` array (after the v5 entry):

```typescript
  {
    version: 6,
    skipIfColumnExists: { table: "runs", column: "source" },
    sql: `
ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'linear';
`,
  },
```

3. In the fresh-install `sqliteSchema` template literal, locate the `CREATE TABLE IF NOT EXISTS runs (...)` block and add the column. The block currently ends with `updated_at TEXT NOT NULL,\n  FOREIGN KEY ...`. Change to:

```sql
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
  source TEXT NOT NULL DEFAULT 'linear',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_slug) REFERENCES projects(slug)
);
```

- [ ] **Step 4: Run all tests to verify nothing else broke**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS. The new migration test passes; existing tests continue to pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db-migration.test.ts
git commit -m "feat(db): add source column to runs table

Migration v6 adds runs.source TEXT NOT NULL DEFAULT 'linear'. Existing
rows are backfilled by the default. Prepares the schema for ad-hoc
prompt-driven runs which set source='adhoc'."
```

---

## Task 2: Type and thread `RunRecord.source`

**Files:**
- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/engine.ts:514` (`createRun`), `src/workflow/engine.ts:54` (`submitRun`), `src/workflow/engine.ts:80-95` (`submitProject`)
- Modify: `src/db/sqlite-run-store.ts` (upsert + load)
- Test: `tests/workflow.test.ts` (add cases for source threading)

- [ ] **Step 1: Write the failing test**

Open `tests/workflow.test.ts`. Add inside the existing top-level `describe`:

```typescript
it("defaults RunRecord.source to 'linear' when source is not provided", () => {
  const engine = createEngineForTest();   // uses your existing helper or createStubWorkflowDependencies
  const result = engine.submitRun({
    projectSlug: "loom",
    issueId: "TEZ-1",
    executionMode: "enqueue",
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) return;
  expect(result.run.source).toBe("linear");
});

it("records RunRecord.source='adhoc' when input.source='adhoc'", () => {
  const engine = createEngineForTest();
  const result = engine.submitRun({
    projectSlug: "loom",
    issueId: "TEZ-2",
    executionMode: "enqueue",
    source: "adhoc",
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) return;
  expect(result.run.source).toBe("adhoc");
});
```

If `tests/workflow.test.ts` does not have a `createEngineForTest` helper, build one inline that mirrors the pattern in `tests/api.test.ts:createTestServer` — use `createStubWorkflowDependencies()` and `parseProjectConfigRegistry(...)` with project slug `"loom"`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run tests/workflow.test.ts
```

Expected: FAIL — type error on `result.run.source` ("Property 'source' does not exist on type 'RunRecord'") and on `source: "adhoc"` ("not assignable to SubmitRunInput").

- [ ] **Step 3: Update types**

Edit `src/workflow/types.ts`:

1. Add a new exported type near the top:

```typescript
export type RunSource = "linear" | "adhoc";
```

2. Extend `SubmitRunInput`:

```typescript
export interface SubmitRunInput {
  projectSlug: string;
  issueId: string;
  executionMode: ExecutionMode;
  source?: RunSource;
}
```

3. Extend `RunRecord` (add the field next to `issueId`):

```typescript
export interface RunRecord {
  id: string;
  projectSlug: string;
  issueId: string;
  source: RunSource;
  state: RunState;
  // ... rest unchanged
}
```

- [ ] **Step 4: Thread source through the engine**

Edit `src/workflow/engine.ts`:

1. In `submitRun` (around line 54), pass `input.source ?? "linear"` to `createRun`:

```typescript
submitRun(input: SubmitRunInput): SubmitRunResult {
  const project = this.projectForSlug(input.projectSlug);

  if (input.executionMode === "run_now_if_idle" && !this.isIdle()) {
    return {
      accepted: false,
      reason: "busy",
      currentRun: this.activeRunId ? this.getRun(this.activeRunId) : null,
      queuedRunIds: [...this.queue],
    };
  }

  this.options.store?.saveProject(project);
  const run = this.createRun(input.projectSlug, input.issueId, input.source ?? "linear");
  this.queue.push(run.id);
  this.refreshQueuePositions();
  this.persistRun(run);

  return {
    accepted: true,
    run,
    queuePosition: run.queuePosition ?? 1,
  };
}
```

2. In `submitProject` (around line 80–95) update the `createRun` call to pass `"linear"` explicitly:

```typescript
const run = this.createRun(projectSlug, issue.identifier, "linear");
```

3. Update `createRun` signature and body (around line 514):

```typescript
private createRun(projectSlug: string, issueId: string, source: RunSource): RunRecord {
  const now = this.now();
  const run: RunRecord = {
    id: this.newId(),
    projectSlug,
    issueId,
    source,
    state: "queued",
    failureReason: null,
    revisionCount: 0,
    createdAt: now,
    updatedAt: now,
    queuePosition: null,
    issueSnapshot: null,
    workspace: null,
    attempts: [],
    events: [],
    handoff: null,
  };

  this.runs.set(run.id, run);
  this.recordEvent(run, "state_transition", "queued", {});
  return run;
}
```

4. Add `RunSource` to the engine's type imports at the top of the file, alongside the existing imports from `./types.js`.

5. In every `this.log.info({ runId: run.id, issueId: run.issueId }, ...)` site (search for `issueId: run.issueId`), add `source: run.source` to the log object. Example:

```typescript
this.log.info({ runId: run.id, issueId: run.issueId, source: run.source }, "executing run");
```

There is one such site at the start of `executeRun`. Update only the entry point — internal step logs don't need it.

- [ ] **Step 5: Persist source through SQLite store**

Edit `src/db/sqlite-run-store.ts`:

1. In `upsertRun` (around line 227), include `source` in the column list, the placeholder list, the `ON CONFLICT ... DO UPDATE` set, and the `.run(...)` arg list:

```typescript
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
```

2. Find the row → RunRecord mapper (search for the function that builds a `RunRecord` from a row — typically `rowToRun` or inline in `getRun`/`listRecoverableRuns`). Add:

```typescript
source: (row["source"] as string | undefined) === "adhoc" ? "adhoc" : "linear",
```

The defensive cast handles the case where an old row read before migration (shouldn't happen, but the migration is `NOT NULL DEFAULT 'linear'` so rows always have a value).

- [ ] **Step 6: Update test fixtures if any construct `RunRecord` directly**

Search for direct `RunRecord` construction outside the engine:

```bash
grep -rn "issueSnapshot: null" src/ tests/
```

If any test fixture constructs a `RunRecord` literal, add `source: "linear"` to it.

- [ ] **Step 7: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add src/workflow/types.ts src/workflow/engine.ts src/db/sqlite-run-store.ts tests/workflow.test.ts
# Plus any test fixtures touched in step 6
git commit -m "feat(workflow): thread RunRecord.source through engine and store

Adds RunSource = 'linear' | 'adhoc' on SubmitRunInput and RunRecord.
SubmitRun defaults to 'linear' when omitted; submitProject always sets
'linear'. SQLite upsert and load round-trip the value. Engine logs
include source on the run-execution entry log."
```

---

## Task 3: Linear adhoc client — `src/linear/issue-create.ts`

**Files:**
- Create: `src/linear/issue-create.ts`
- Modify: `src/linear/linear-workflow-client.ts` (implement new methods on `LinearWorkflowClientImpl` and add to `createMissingKeyClient`)
- Modify: `src/linear/index.ts` (re-export new types)
- Test: `tests/linear/issue-create.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/linear/issue-create.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import {
  createAdhocIssue,
  type LinearAdhocClient,
  type AdhocIssueParams,
} from "../../src/linear/issue-create.js";

function fakeClient(overrides: Partial<LinearAdhocClient> = {}): LinearAdhocClient {
  return {
    findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    findBacklogState: vi.fn(async () => ({ id: "state-backlog" })),
    findProjectIdByName: vi.fn(async () => "proj-1"),
    findTeamIdByKey: vi.fn(async () => "team-1"),
    createIssue: vi.fn(async () => ({
      identifier: "LOOM-456",
      url: "https://linear.app/x/issue/LOOM-456",
    })),
    ...overrides,
  };
}

const baseParams: AdhocIssueParams = {
  teamKey: "LOOM",
  projectName: "loom",
  labelName: "loomforge-adhoc",
  backlogStateName: "Backlog",
  title: "Fix the typo in README",
  description: "Fix the typo in README\n\n_Submitted via Loomforge ad-hoc on 2026-04-26._",
};

describe("createAdhocIssue", () => {
  it("creates an issue with the provided title, description, label, project, team, and backlog state", async () => {
    const client = fakeClient();
    const result = await createAdhocIssue(client, baseParams);

    expect(result).toEqual({
      identifier: "LOOM-456",
      url: "https://linear.app/x/issue/LOOM-456",
    });
    expect(client.createIssue).toHaveBeenCalledWith({
      title: baseParams.title,
      description: baseParams.description,
      teamId: "team-1",
      projectId: "proj-1",
      stateId: "state-backlog",
      labelIds: ["lbl-1"],
    });
  });

  it("creates the label when findLabel returns null", async () => {
    const client = fakeClient({
      findLabel: vi.fn(async () => null),
      createLabel: vi.fn(async () => ({ id: "lbl-new", name: "loomforge-adhoc" })),
    });
    await createAdhocIssue(client, baseParams);
    expect(client.createLabel).toHaveBeenCalledWith({
      teamId: "team-1",
      name: "loomforge-adhoc",
    });
  });

  it("retries label resolution once if createLabel fails (race), then re-finds", async () => {
    const findLabel = vi.fn();
    findLabel.mockResolvedValueOnce(null);                       // 1st probe
    findLabel.mockResolvedValueOnce({ id: "lbl-race", name: "loomforge-adhoc" }); // 2nd probe after race

    const client = fakeClient({
      findLabel,
      createLabel: vi.fn(async () => {
        throw new Error("label already exists");
      }),
    });

    const result = await createAdhocIssue(client, baseParams);
    expect(result.identifier).toBe("LOOM-456");
    expect(findLabel).toHaveBeenCalledTimes(2);
  });

  it("throws label_setup_failed if createLabel fails AND the second findLabel still returns null", async () => {
    const findLabel = vi.fn();
    findLabel.mockResolvedValueOnce(null);
    findLabel.mockResolvedValueOnce(null);

    const client = fakeClient({
      findLabel,
      createLabel: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });

    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/label_setup_failed/);
  });

  it("throws missing_backlog_state when findBacklogState returns null", async () => {
    const client = fakeClient({
      findBacklogState: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_backlog_state/);
  });

  it("throws missing_team when findTeamIdByKey returns null", async () => {
    const client = fakeClient({
      findTeamIdByKey: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_team/);
  });

  it("throws missing_project when findProjectIdByName returns null", async () => {
    const client = fakeClient({
      findProjectIdByName: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_project/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run tests/linear/issue-create.test.ts
```

Expected: FAIL — module `src/linear/issue-create.ts` does not exist.

- [ ] **Step 3: Implement the adhoc client interface and `createAdhocIssue`**

Create `src/linear/issue-create.ts`:

```typescript
export interface LinearLabelSummary {
  id: string;
  name: string;
}

export interface LinearStateSummary {
  id: string;
}

export interface LinearAdhocIssueResult {
  identifier: string;
  url: string;
}

export interface LinearAdhocCreateIssueInput {
  title: string;
  description: string;
  teamId: string;
  projectId: string;
  stateId: string;
  labelIds: string[];
}

export interface LinearAdhocClient {
  findTeamIdByKey(teamKey: string): Promise<string | null>;
  findProjectIdByName(teamId: string, name: string): Promise<string | null>;
  findLabel(teamId: string, name: string): Promise<LinearLabelSummary | null>;
  createLabel(input: { teamId: string; name: string }): Promise<LinearLabelSummary>;
  findBacklogState(teamId: string, name: string): Promise<LinearStateSummary | null>;
  createIssue(input: LinearAdhocCreateIssueInput): Promise<LinearAdhocIssueResult>;
}

export interface AdhocIssueParams {
  teamKey: string;
  projectName: string;
  labelName: string;
  backlogStateName: string;
  title: string;
  description: string;
}

export class AdhocIssueError extends Error {
  readonly reason:
    | "missing_team"
    | "missing_project"
    | "missing_backlog_state"
    | "label_setup_failed"
    | "issue_create_failed";

  constructor(
    reason: AdhocIssueError["reason"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AdhocIssueError";
    this.reason = reason;
  }
}

export async function createAdhocIssue(
  client: LinearAdhocClient,
  params: AdhocIssueParams,
): Promise<LinearAdhocIssueResult> {
  const teamId = await client.findTeamIdByKey(params.teamKey);
  if (!teamId) {
    throw new AdhocIssueError(
      "missing_team",
      `Linear team not found for key "${params.teamKey}"`,
    );
  }

  const projectId = await client.findProjectIdByName(teamId, params.projectName);
  if (!projectId) {
    throw new AdhocIssueError(
      "missing_project",
      `Linear project not found by name "${params.projectName}" on team "${params.teamKey}"`,
    );
  }

  const stateId = await resolveBacklogState(client, teamId, params.backlogStateName);
  const labelId = await resolveLabel(client, teamId, params.labelName);

  try {
    return await client.createIssue({
      title: params.title,
      description: params.description,
      teamId,
      projectId,
      stateId: stateId.id,
      labelIds: [labelId.id],
    });
  } catch (cause) {
    throw new AdhocIssueError(
      "issue_create_failed",
      `Linear issueCreate failed: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

async function resolveBacklogState(
  client: LinearAdhocClient,
  teamId: string,
  name: string,
): Promise<LinearStateSummary> {
  const state = await client.findBacklogState(teamId, name);
  if (!state) {
    throw new AdhocIssueError(
      "missing_backlog_state",
      `Linear workflow state "${name}" not found on team`,
    );
  }
  return state;
}

async function resolveLabel(
  client: LinearAdhocClient,
  teamId: string,
  name: string,
): Promise<LinearLabelSummary> {
  const existing = await client.findLabel(teamId, name);
  if (existing) {
    return existing;
  }

  try {
    return await client.createLabel({ teamId, name });
  } catch (createError) {
    const second = await client.findLabel(teamId, name);
    if (second) {
      return second;
    }
    throw new AdhocIssueError(
      "label_setup_failed",
      `Failed to ensure Linear label "${name}": ${errorMessage(createError)}`,
      { cause: createError },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the new test to verify it passes**

```bash
pnpm exec vitest run tests/linear/issue-create.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement the methods on `LinearWorkflowClientImpl`**

Edit `src/linear/linear-workflow-client.ts`:

1. Add the import at the top:

```typescript
import type {
  LinearAdhocClient,
  LinearAdhocCreateIssueInput,
  LinearAdhocIssueResult,
  LinearLabelSummary,
  LinearStateSummary,
} from "./issue-create.js";
```

2. Update the class declaration to also implement `LinearAdhocClient`:

```typescript
export class LinearWorkflowClientImpl
  implements LinearWorkflowClient, LinearDesignClient, LinearAdhocClient {
```

3. Add these methods inside the class (anywhere — after `updateIssueStatus` is fine):

```typescript
async findTeamIdByKey(teamKey: string): Promise<string | null> {
  return this.safeRequest(async () => {
    const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
    const team = teams.nodes[0];
    return team?.id ?? null;
  });
}

async findProjectIdByName(teamId: string, name: string): Promise<string | null> {
  return this.safeRequest(async () => {
    const team = await this.client.team(teamId).catch(() => null);
    if (!team) return null;
    const projects = await team.projects({ filter: { name: { eq: name } } });
    return projects.nodes[0]?.id ?? null;
  });
}

async findLabel(teamId: string, name: string): Promise<LinearLabelSummary | null> {
  return this.safeRequest(async () => {
    const team = await this.client.team(teamId).catch(() => null);
    if (!team) return null;
    const labels = await team.labels({ filter: { name: { eq: name } } });
    const label = labels.nodes[0];
    return label ? { id: label.id, name: label.name } : null;
  });
}

async createLabel(input: { teamId: string; name: string }): Promise<LinearLabelSummary> {
  return this.safeRequest(async () => {
    const payload = await this.client.createIssueLabel({
      teamId: input.teamId,
      name: input.name,
    });
    const label = await payload.issueLabel;
    if (!label) {
      throw new Error(`Linear createIssueLabel returned no label for "${input.name}"`);
    }
    return { id: label.id, name: label.name };
  });
}

async findBacklogState(teamId: string, name: string): Promise<LinearStateSummary | null> {
  return this.safeRequest(async () => {
    const team = await this.client.team(teamId).catch(() => null);
    if (!team) return null;
    const states = await team.states();
    const state = states.nodes.find((s) => s.name === name);
    return state ? { id: state.id } : null;
  });
}

async createIssue(input: LinearAdhocCreateIssueInput): Promise<LinearAdhocIssueResult> {
  return this.safeRequest(async () => {
    const payload = await this.client.createIssue({
      title: input.title,
      description: input.description,
      teamId: input.teamId,
      projectId: input.projectId,
      stateId: input.stateId,
      labelIds: input.labelIds,
    });
    const issue = await payload.issue;
    if (!issue) {
      throw new Error(`Linear createIssue returned no issue for "${input.title}"`);
    }
    return { identifier: issue.identifier, url: issue.url };
  });
}
```

If the SDK method names differ in the installed version (e.g., `issueCreate` vs `createIssue`), use whichever the existing client uses for design (`createDocument`, `createProject`). The `@linear/sdk` `LinearClient` exposes both `client.createIssue(...)` and `client.issueCreate(...)` historically; pick the one matching the project's installed types — `pnpm typecheck` will tell you if the wrong one is used.

4. Update `createMissingKeyClient` to also stub the new methods. Add to its return object:

```typescript
findTeamIdByKey: err,
findProjectIdByName: err,
findLabel: err,
createLabel: err,
findBacklogState: err,
createIssue: err,
```

And update its return type:

```typescript
export function createMissingKeyClient(): LinearWorkflowClient & LinearDesignClient & LinearAdhocClient {
```

- [ ] **Step 6: Re-export from `src/linear/index.ts`**

Edit `src/linear/index.ts`. After existing re-exports, add:

```typescript
export {
  createAdhocIssue,
  AdhocIssueError,
  type LinearAdhocClient,
  type LinearAdhocCreateIssueInput,
  type LinearAdhocIssueResult,
  type LinearLabelSummary,
  type LinearStateSummary,
  type AdhocIssueParams,
} from "./issue-create.js";
```

- [ ] **Step 7: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add src/linear/issue-create.ts src/linear/linear-workflow-client.ts src/linear/index.ts tests/linear/issue-create.test.ts
git commit -m "feat(linear): add adhoc issue creation client

Adds LinearAdhocClient interface plus createAdhocIssue() free function
that resolves team, project, backlog state, and label (with one race
retry on label create), then creates the issue. Implements the
interface on LinearWorkflowClientImpl. Errors typed as AdhocIssueError
with reason discriminator: missing_team | missing_project |
missing_backlog_state | label_setup_failed | issue_create_failed."
```

---

## Task 4: Adhoc orchestrator — `src/workflow/adhoc.ts`

**Files:**
- Create: `src/workflow/adhoc.ts`
- Modify: `src/workflow/index.ts` (re-export)
- Test: `tests/workflow/adhoc.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/workflow/adhoc.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import { parseProjectConfigRegistry } from "../../src/config/index.js";
import {
  submitAdhocRun,
  type AdhocRunDeps,
  type AdhocSubmitInput,
} from "../../src/workflow/adhoc.js";

const REGISTRY_YAML = `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    linearTeamKey: TEZ
    linearProjectName: loom
    verification:
      commands:
        - name: test
          command: pnpm test
  - slug: bare
    repoRoot: /repos/bare
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
`;

function makeDeps(overrides: Partial<AdhocRunDeps> = {}): AdhocRunDeps {
  return {
    registry: parseProjectConfigRegistry(REGISTRY_YAML, { homeDir: "/Users/test" }),
    linear: {
      findTeamIdByKey: vi.fn(async () => "team-1"),
      findProjectIdByName: vi.fn(async () => "proj-1"),
      findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
      createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
      findBacklogState: vi.fn(async () => ({ id: "state-1" })),
      createIssue: vi.fn(async () => ({
        identifier: "TEZ-100",
        url: "https://linear.app/tez/issue/TEZ-100",
      })),
    },
    engine: {
      submitRun: vi.fn(() => ({
        accepted: true,
        run: {
          id: "run-uuid",
          projectSlug: "loom",
          issueId: "TEZ-100",
          source: "adhoc",
          state: "queued",
          failureReason: null,
          revisionCount: 0,
          createdAt: "2026-04-26T00:00:00.000Z",
          updatedAt: "2026-04-26T00:00:00.000Z",
          queuePosition: 1,
          issueSnapshot: null,
          workspace: null,
          attempts: [],
          events: [],
          handoff: null,
        },
        queuePosition: 1,
      })),
    },
    scheduler: { schedule: vi.fn() },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    ...overrides,
  };
}

const baseInput: AdhocSubmitInput = {
  project: "loom",
  prompt: "Fix the typo in README",
};

describe("submitAdhocRun", () => {
  it("resolves slug, creates a Linear issue, submits a run, and returns the payload", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, baseInput);

    expect(result).toEqual({
      ok: true,
      runId: "run-uuid",
      issueId: "TEZ-100",
      linearUrl: "https://linear.app/tez/issue/TEZ-100",
      queuePosition: 1,
    });
    expect(deps.linear.createIssue).toHaveBeenCalledTimes(1);
    expect(deps.engine.submitRun).toHaveBeenCalledWith({
      projectSlug: "loom",
      issueId: "TEZ-100",
      executionMode: "enqueue",
      source: "adhoc",
    });
    expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it("resolves an absolute repoRoot path to its registered project", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "/repos/loom", prompt: "x" });
    expect(result.ok).toBe(true);
    expect(deps.engine.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: "loom" }),
    );
  });

  it("returns project_not_found when the slug is unknown", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "missing", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "project_not_found",
      projectIdentifier: "missing",
    });
    expect(deps.linear.createIssue).not.toHaveBeenCalled();
    expect(deps.engine.submitRun).not.toHaveBeenCalled();
  });

  it("rejects relative paths as validation_failed", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "./loom", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "validation_failed",
      details: expect.stringMatching(/absolute/i),
    });
  });

  it("returns validation_failed for empty / whitespace-only prompts", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "loom", prompt: "   \n   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
  });

  it("returns validation_failed for prompts longer than 8000 chars", async () => {
    const deps = makeDeps();
    const big = "x".repeat(8001);
    const result = await submitAdhocRun(deps, { project: "loom", prompt: big });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
  });

  it("returns linear_not_configured when the project lacks linearTeamKey or linearProjectName", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "bare", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "linear_not_configured",
      projectSlug: "bare",
      missing: expect.arrayContaining(["linearTeamKey", "linearProjectName"]),
    });
    expect(deps.linear.createIssue).not.toHaveBeenCalled();
  });

  it("maps AdhocIssueError to linear_create_failed with reason", async () => {
    const deps = makeDeps({
      linear: {
        ...makeDeps().linear,
        findBacklogState: vi.fn(async () => null),
      },
    });
    const result = await submitAdhocRun(deps, baseInput);
    expect(result).toEqual({
      ok: false,
      error: "linear_create_failed",
      reason: "missing_backlog_state",
      message: expect.stringContaining("Backlog"),
    });
  });

  it("returns submit_after_create_failed (with orphanedIssueId) if submitRun throws after issue is created", async () => {
    const deps = makeDeps({
      engine: {
        submitRun: vi.fn(() => {
          throw new Error("db unavailable");
        }),
      },
    });
    const result = await submitAdhocRun(deps, baseInput);
    expect(result).toEqual({
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: "TEZ-100",
      message: expect.stringContaining("db unavailable"),
    });
  });

  it("derives title from the first non-empty line truncated at 80 chars and includes the dated footer", async () => {
    const deps = makeDeps();
    const longLine = "x".repeat(120);
    const prompt = `\n\n   \n${longLine}\nMore detail on the next line.`;
    await submitAdhocRun(deps, { project: "loom", prompt });

    const args = (deps.linear.createIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(args.title).toBe("x".repeat(80));
    expect(args.description).toBe(prompt + "\n\n_Submitted via Loomforge ad-hoc on 2026-04-26._");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run tests/workflow/adhoc.test.ts
```

Expected: FAIL — module `src/workflow/adhoc.ts` does not exist.

- [ ] **Step 3: Implement the orchestrator**

Create `src/workflow/adhoc.ts`:

```typescript
import { isAbsolute, resolve } from "node:path";

import type { ProjectConfig, ProjectConfigRegistry } from "../config/index.js";
import {
  AdhocIssueError,
  createAdhocIssue,
  type LinearAdhocClient,
} from "../linear/index.js";
import type { SubmitRunInput, SubmitRunResult } from "./types.js";

const PROMPT_MAX_LEN = 8000;
const TITLE_MAX_LEN = 80;
const ADHOC_LABEL = "loomforge-adhoc";
const BACKLOG_STATE_NAME = "Backlog";

export interface AdhocSubmitInput {
  project: string;
  prompt: string;
}

export interface AdhocRunDeps {
  registry: ProjectConfigRegistry;
  linear: LinearAdhocClient;
  engine: { submitRun(input: SubmitRunInput): SubmitRunResult };
  scheduler: { schedule(): void };
  now: () => Date;
}

export type AdhocSubmitResult =
  | {
      ok: true;
      runId: string;
      issueId: string;
      linearUrl: string;
      queuePosition: number;
    }
  | { ok: false; error: "validation_failed"; details: string }
  | { ok: false; error: "project_not_found"; projectIdentifier: string }
  | {
      ok: false;
      error: "linear_not_configured";
      projectSlug: string;
      missing: string[];
    }
  | {
      ok: false;
      error: "linear_create_failed";
      reason: AdhocIssueError["reason"];
      message: string;
    }
  | {
      ok: false;
      error: "submit_after_create_failed";
      orphanedIssueId: string;
      message: string;
    };

export async function submitAdhocRun(
  deps: AdhocRunDeps,
  input: AdhocSubmitInput,
): Promise<AdhocSubmitResult> {
  const promptError = validatePrompt(input.prompt);
  if (promptError) {
    return { ok: false, error: "validation_failed", details: promptError };
  }

  const projectResolution = resolveProject(deps.registry, input.project);
  if (projectResolution.kind === "validation_failed") {
    return { ok: false, error: "validation_failed", details: projectResolution.details };
  }
  if (projectResolution.kind === "not_found") {
    return {
      ok: false,
      error: "project_not_found",
      projectIdentifier: input.project,
    };
  }

  const project = projectResolution.project;
  const missing: string[] = [];
  if (!project.linearTeamKey) missing.push("linearTeamKey");
  if (!project.linearProjectName) missing.push("linearProjectName");
  if (missing.length > 0) {
    return {
      ok: false,
      error: "linear_not_configured",
      projectSlug: project.slug,
      missing,
    };
  }

  const title = deriveTitle(input.prompt);
  const description = buildDescription(input.prompt, deps.now());

  let issue: { identifier: string; url: string };
  try {
    issue = await createAdhocIssue(deps.linear, {
      teamKey: project.linearTeamKey!,
      projectName: project.linearProjectName!,
      labelName: ADHOC_LABEL,
      backlogStateName: BACKLOG_STATE_NAME,
      title,
      description,
    });
  } catch (error) {
    if (error instanceof AdhocIssueError) {
      return {
        ok: false,
        error: "linear_create_failed",
        reason: error.reason,
        message: error.message,
      };
    }
    return {
      ok: false,
      error: "linear_create_failed",
      reason: "issue_create_failed",
      message: errorMessage(error),
    };
  }

  let result: SubmitRunResult;
  try {
    result = deps.engine.submitRun({
      projectSlug: project.slug,
      issueId: issue.identifier,
      executionMode: "enqueue",
      source: "adhoc",
    });
  } catch (error) {
    return {
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: issue.identifier,
      message: errorMessage(error),
    };
  }

  if (!result.accepted) {
    // submitRun only rejects on busy + run_now_if_idle. We always enqueue, so
    // this is unreachable. Treat as submit_after_create_failed for safety.
    return {
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: issue.identifier,
      message: `submitRun rejected: ${result.reason}`,
    };
  }

  deps.scheduler.schedule();

  return {
    ok: true,
    runId: result.run.id,
    issueId: issue.identifier,
    linearUrl: issue.url,
    queuePosition: result.queuePosition,
  };
}

function validatePrompt(prompt: string): string | null {
  if (typeof prompt !== "string") return "prompt must be a string";
  if (prompt.trim().length === 0) return "prompt must not be empty or whitespace-only";
  if (prompt.length > PROMPT_MAX_LEN) {
    return `prompt exceeds ${PROMPT_MAX_LEN}-character limit`;
  }
  return null;
}

type ProjectResolution =
  | { kind: "ok"; project: ProjectConfig }
  | { kind: "not_found" }
  | { kind: "validation_failed"; details: string };

function resolveProject(
  registry: ProjectConfigRegistry,
  identifier: string,
): ProjectResolution {
  if (identifier.length === 0) {
    return { kind: "validation_failed", details: "project must not be empty" };
  }

  const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (slugPattern.test(identifier)) {
    const project = registry.bySlug.get(identifier);
    return project ? { kind: "ok", project } : { kind: "not_found" };
  }

  if (!isAbsolute(identifier)) {
    return {
      kind: "validation_failed",
      details: "project must be a slug or an absolute path",
    };
  }

  const target = resolve(identifier);
  for (const project of registry.projects) {
    if (resolve(project.repoRoot) === target) {
      return { kind: "ok", project };
    }
  }
  return { kind: "not_found" };
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const source = firstLine ?? prompt.trim();
  return source.length > TITLE_MAX_LEN ? source.slice(0, TITLE_MAX_LEN) : source;
}

function buildDescription(prompt: string, now: Date): string {
  const datePart = now.toISOString().slice(0, 10);
  return `${prompt}\n\n_Submitted via Loomforge ad-hoc on ${datePart}._`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Re-export from workflow index**

Edit `src/workflow/index.ts`. Add:

```typescript
export {
  submitAdhocRun,
  type AdhocSubmitInput,
  type AdhocSubmitResult,
  type AdhocRunDeps,
} from "./adhoc.js";
```

- [ ] **Step 5: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/adhoc.ts src/workflow/index.ts tests/workflow/adhoc.test.ts
git commit -m "feat(workflow): add adhoc submission orchestrator

submitAdhocRun() resolves a project (slug or absolute path) against the
registry, validates Linear preconditions, derives a title and dated
footer, calls createAdhocIssue, then enqueues a normal build run with
source='adhoc'. All error paths typed via AdhocSubmitResult; no side
effect happens before validation passes. Linear issue is created only
after every other precondition succeeds."
```

---

## Task 5: HTTP route — `POST /runs/adhoc`

**Files:**
- Modify: `src/api/server.ts` (route + zod schema)
- Modify: `src/app/server.ts` (wire `LinearAdhocClient` through to the route handler — see Step 5 below)
- Modify: `src/workflow/engine.ts` (expose `getRegistry()` if not already public)
- Test: `tests/api/runs-adhoc.test.ts` (new)

- [ ] **Step 1: Read the existing wiring**

Open `src/app/server.ts` and identify how the workflow engine, Linear client, and scheduler are constructed and passed into `createApiServer`. The route in this task will need access to:
- the registry (already on the engine via `options.registry`)
- the Linear client cast to `LinearAdhocClient` (the same instance as the existing `LinearWorkflowClient`)
- the workflow engine (for `submitRun`)
- the scheduler

If `CreateApiServerOptions` doesn't already expose all four, extend it.

- [ ] **Step 2: Write the failing test**

Create `tests/api/` directory if missing, then create `tests/api/runs-adhoc.test.ts`:

```typescript
import pino from "pino";
import { describe, it, expect, vi } from "vitest";

import { createApiServer } from "../../src/api/index.js";
import { createStubWorkflowDependencies } from "../../src/app/index.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";
import type { LinearAdhocClient } from "../../src/linear/index.js";
import { WorkflowEngine } from "../../src/workflow/index.js";

const REGISTRY_YAML = `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    linearTeamKey: TEZ
    linearProjectName: loom
    verification:
      commands:
        - name: test
          command: pnpm test
  - slug: bare
    repoRoot: /repos/bare
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
`;

function makeAdhocLinear(overrides: Partial<LinearAdhocClient> = {}): LinearAdhocClient {
  return {
    findTeamIdByKey: vi.fn(async () => "team-1"),
    findProjectIdByName: vi.fn(async () => "proj-1"),
    findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    findBacklogState: vi.fn(async () => ({ id: "state-1" })),
    createIssue: vi.fn(async () => ({
      identifier: "TEZ-100",
      url: "https://linear.app/tez/issue/TEZ-100",
    })),
    ...overrides,
  };
}

function makeServer(adhocLinear: LinearAdhocClient = makeAdhocLinear()) {
  const registry = parseProjectConfigRegistry(REGISTRY_YAML, { homeDir: "/Users/test" });
  const stub = createStubWorkflowDependencies();
  const engine = new WorkflowEngine({
    registry,
    linear: stub.linear,
    worktrees: stub.worktrees,
    builder: stub.builder,
    reviewer: stub.reviewer,
  });
  let scheduled = 0;
  const scheduler = {
    schedule: () => {
      scheduled += 1;
    },
    drainNow: async () => {
      await engine.drainQueue();
    },
  };
  const server = createApiServer({
    engine,
    scheduler,
    adhocLinear,
    logger: pino({ level: "silent" }),
  });
  return { server, getScheduledCount: () => scheduled };
}

describe("POST /runs/adhoc", () => {
  it("returns 200 with the run + Linear identifiers on the happy path", async () => {
    const { server, getScheduledCount } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "Fix the typo in README" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      runId: expect.any(String),
      issueId: "TEZ-100",
      linearUrl: "https://linear.app/tez/issue/TEZ-100",
      queuePosition: 1,
    });
    expect(getScheduledCount()).toBe(1);
  });

  it("returns 400 validation_failed for an empty prompt", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_failed" });
  });

  it("returns 404 project_not_found for an unknown slug", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "missing", prompt: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: "project_not_found",
      projectIdentifier: "missing",
    });
  });

  it("returns 409 linear_not_configured for a project without linearTeamKey/linearProjectName", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "bare", prompt: "x" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "linear_not_configured",
      projectSlug: "bare",
      missing: expect.arrayContaining(["linearTeamKey", "linearProjectName"]),
    });
  });

  it("returns 502 linear_create_failed when issue creation fails", async () => {
    const { server } = makeServer(
      makeAdhocLinear({
        findBacklogState: vi.fn(async () => null),
      }),
    );
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "x" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: "linear_create_failed",
      reason: "missing_backlog_state",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm exec vitest run tests/api/runs-adhoc.test.ts
```

Expected: FAIL — route does not exist (404), or `adhocLinear` not accepted by `createApiServer` options.

- [ ] **Step 4: Add the route**

Edit `src/api/server.ts`:

1. Add the imports near the top:

```typescript
import type { LinearAdhocClient } from "../linear/index.js";
import { submitAdhocRun } from "../workflow/index.js";
```

2. Extend `CreateApiServerOptions`:

```typescript
export interface CreateApiServerOptions {
  engine: WorkflowEngine;
  scheduler: DrainScheduler;
  adhocLinear?: LinearAdhocClient;
  store?: SqliteRunStore;
  artifactStore?: ArtifactStore;
  designEngine?: DesignEngine;
  designScheduler?: DrainScheduler;
  reloadConfig?: () => Promise<{ projects: number; slugs: string[] }>;
  logger: Logger;
}
```

3. Add the zod schema next to the existing `submitRunSchema`:

```typescript
const submitAdhocSchema = z
  .object({
    project: z.string().trim().min(1),
    prompt: z.string().min(1).max(8000),
  })
  .strict();
```

4. Inside `createApiServer`, add the route after the existing `POST /runs` handler:

```typescript
server.post("/runs/adhoc", async (request, reply) => {
  if (!options.adhocLinear) {
    return reply.code(501).send({ error: "adhoc_unavailable" });
  }

  const parsed = submitAdhocSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send({ error: "validation_failed", details: parsed.error.flatten() });
  }

  const result = await submitAdhocRun(
    {
      registry: options.engine.getRegistry(),
      linear: options.adhocLinear,
      engine: options.engine,
      scheduler: options.scheduler,
      now: () => new Date(),
    },
    parsed.data,
  );

  if (result.ok) {
    return reply.code(200).send({
      runId: result.runId,
      issueId: result.issueId,
      linearUrl: result.linearUrl,
      queuePosition: result.queuePosition,
    });
  }

  switch (result.error) {
    case "validation_failed":
      return reply.code(400).send(result);
    case "project_not_found":
      return reply.code(404).send(result);
    case "linear_not_configured":
      return reply.code(409).send(result);
    case "linear_create_failed":
      return reply.code(502).send(result);
    case "submit_after_create_failed":
      return reply.code(500).send(result);
  }
});
```

5. The route reads the registry from the engine. If `WorkflowEngine` does not already expose `getRegistry()`, add a public method:

```typescript
getRegistry(): ProjectConfigRegistry {
  return this.options.registry;
}
```

(Add `ProjectConfigRegistry` to the existing type import from `../config/index.js` if not already imported.)

- [ ] **Step 5: Wire `adhocLinear` in app composition**

Edit `src/app/server.ts` (or wherever `createApiServer({...})` is invoked at startup). The Linear workflow client already implements `LinearAdhocClient` after Task 3. Pass the same instance:

```typescript
createApiServer({
  engine,
  scheduler,
  adhocLinear: linearClient,   // same LinearWorkflowClientImpl instance
  // ...existing options
});
```

If the app currently uses `createMissingKeyClient()` when no API key is configured, that stub also implements `LinearAdhocClient` after Task 3. Keep passing it through; the route still works (calls hit the stub `err()` and return `linear_create_failed`).

- [ ] **Step 6: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/server.ts src/app/server.ts src/workflow/engine.ts tests/api/runs-adhoc.test.ts
git commit -m "feat(api): add POST /runs/adhoc route

Submits an ad-hoc prompt as a Linear issue + queued run. 200 returns
runId/issueId/linearUrl/queuePosition. Errors map cleanly: 400
validation_failed, 404 project_not_found, 409 linear_not_configured,
502 linear_create_failed, 500 submit_after_create_failed. Wires the
workflow Linear client through as adhocLinear so it sees the same auth
state as the existing flows."
```

---

## Task 6: CLI — `loomforge run "<prompt>" --project`

**Files:**
- Modify: `src/cli/program.ts` (new command)
- Test: `tests/cli/program.test.ts` (new test cases in existing file)

- [ ] **Step 1: Write the failing test**

Open `tests/cli/program.test.ts`. Find the existing pattern that injects a fake fetch / HTTP responder. Add a new test case in the same `describe`:

```typescript
it("loomforge run posts to /runs/adhoc with project + prompt and prints the payload", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.init = init;
    return new Response(
      JSON.stringify({
        runId: "run-1",
        issueId: "TEZ-100",
        linearUrl: "https://linear.app/x/issue/TEZ-100",
        queuePosition: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const written: string[] = [];
  const program = createCliProgram({
    write: (text) => {
      written.push(text);
    },
    fetch: fakeFetch,
  });

  await program.parseAsync(
    ["node", "loomforge", "run", "Fix the typo in README", "--project", "loom"],
    { from: "user" },
  );

  expect(captured.url).toContain("/runs/adhoc");
  expect(captured.init?.method).toBe("POST");
  const body = JSON.parse(String(captured.init?.body ?? "{}"));
  expect(body).toEqual({ project: "loom", prompt: "Fix the typo in README" });
  expect(written.join("")).toContain("TEZ-100");
});

it("loomforge run requires --project (no CWD fallback)", async () => {
  const program = createCliProgram({
    write: () => {},
    fetch: (async () => new Response("{}")) as typeof fetch,
  });

  await expect(
    program.parseAsync(["node", "loomforge", "run", "x"], { from: "user" }),
  ).rejects.toThrow(/project/i);
});
```

If the existing CLI tests don't already inject a `fetch` (the http-client may use the global), check `src/cli/http-client.ts:11` — it calls `fetch(...)` directly. Either:
- (preferred) extend `LoomHttpClientOptions` to accept an optional `fetch` and thread it through `requestJson`, then surface it on `CreateCliProgramOptions`.
- or set up a mock with `vi.stubGlobal("fetch", fakeFetch)` and `vi.unstubAllGlobals()` in `afterEach`.

Pick whichever the existing tests already use; if neither, use `vi.stubGlobal`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run tests/cli/program.test.ts
```

Expected: FAIL — `run` is not a known command.

- [ ] **Step 3: Add the command**

Edit `src/cli/program.ts`. After the existing `submit` command and before `queue`, add:

```typescript
program
  .command("run")
  .description("Submit an ad-hoc prompt-driven run for a project")
  .argument("<prompt>")
  .requiredOption(
    "-p, --project <slug-or-path>",
    "registered project slug or absolute path to its repoRoot",
  )
  .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
  .action(async (prompt: string, commandOptions: RunCommandOptions) => {
    writeJson(
      write,
      await requestJson({ baseUrl: commandOptions.url }, "POST", "/runs/adhoc", {
        project: commandOptions.project,
        prompt,
      }),
    );
  });
```

Add the matching `RunCommandOptions` type next to the other command options interfaces:

```typescript
interface RunCommandOptions extends UrlCommandOptions {
  project: string;
}
```

The `--project` flag is `requiredOption`, so Commander produces a usage error if it's missing — exactly the "no CWD fallback" guarantee from the spec.

- [ ] **Step 4: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/program.ts tests/cli/program.test.ts
git commit -m "feat(cli): add loomforge run for adhoc prompt submissions

\`loomforge run \"<prompt>\" --project <slug-or-path>\` posts to
/runs/adhoc and prints the JSON payload. --project is required;
omitting it produces a Commander usage error (no CWD fallback)."
```

---

## Task 7: MCP tool — `loom_submit_adhoc`

**Files:**
- Modify: `src/mcp/http-adapter.ts` (extend `LoomHttpAdapter`)
- Modify: `src/mcp/server.ts` (register tool)
- Test: `tests/mcp/server.test.ts` and `tests/mcp/http-adapter.test.ts` (new test cases in existing files)

- [ ] **Step 1: Write the failing tests**

Open `tests/mcp/http-adapter.test.ts`. Add a new test in the existing `describe`:

```typescript
it("submitAdhocRun posts to /runs/adhoc with project + prompt", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.init = init;
    return new Response(
      JSON.stringify({
        runId: "run-1",
        issueId: "TEZ-100",
        linearUrl: "https://linear.app/x/issue/TEZ-100",
        queuePosition: 1,
      }),
      { status: 200 },
    );
  };
  const adapter = createHttpAdapter({ baseUrl: "http://localhost:3777", fetch: fakeFetch });
  const result = await adapter.submitAdhocRun("loom", "Fix the typo in README");
  expect(captured.url).toContain("/runs/adhoc");
  const body = JSON.parse(String(captured.init?.body ?? "{}"));
  expect(body).toEqual({ project: "loom", prompt: "Fix the typo in README" });
  expect(result).toMatchObject({ issueId: "TEZ-100" });
});
```

Open `tests/mcp/server.test.ts`. Add a new test:

```typescript
it("loom_submit_adhoc tool delegates to adapter.submitAdhocRun", async () => {
  const submitAdhocRun = vi.fn(async () => ({
    runId: "run-1",
    issueId: "TEZ-100",
    linearUrl: "https://linear.app/x/issue/TEZ-100",
    queuePosition: 1,
  }));
  const adapter = makeAdapter({ submitAdhocRun });
  const mcp = createMcpServer(adapter);
  const result = await callTool(mcp, "loom_submit_adhoc", {
    project: "loom",
    prompt: "Fix the typo in README",
  });
  expect(submitAdhocRun).toHaveBeenCalledWith("loom", "Fix the typo in README");
  expect(result.isError).toBeUndefined();
  expect(result.content[0]!.text).toContain("TEZ-100");
});
```

Use whatever helpers (`makeAdapter`, `callTool`) the existing MCP tests use. If they don't have helpers, mirror the pattern from the nearest existing tool test in the same file.

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm exec vitest run tests/mcp/
```

Expected: FAIL — `submitAdhocRun` does not exist on `LoomHttpAdapter`; tool `loom_submit_adhoc` not registered.

- [ ] **Step 3: Add the adapter method**

Edit `src/mcp/http-adapter.ts`:

1. Add to the `LoomHttpAdapter` interface:

```typescript
submitAdhocRun(project: string, prompt: string): Promise<unknown>;
```

2. Add the implementation in `createHttpAdapter`:

```typescript
submitAdhocRun: (project, prompt) =>
  requestJson(options, "POST", "/runs/adhoc", { project, prompt }),
```

- [ ] **Step 4: Register the MCP tool**

Edit `src/mcp/server.ts`. After `loom_submit_run` (around line 35) and before `loom_get_run`, add:

```typescript
mcp.tool(
  "loom_submit_adhoc",
  "Submit an ad-hoc prompt-driven run. Loomforge creates a Linear issue from the prompt under the project's Linear project (label: loomforge-adhoc), then enqueues a normal build run.",
  {
    project: z
      .string()
      .min(1)
      .describe("Registered project slug or absolute path to its repoRoot"),
    prompt: z
      .string()
      .min(1)
      .max(8000)
      .describe("Free-text task description (≤ 8000 chars)"),
  },
  async ({ project, prompt }) => {
    return safeCall(() => adapter.submitAdhocRun(project, prompt));
  },
);
```

- [ ] **Step 5: Run all tests**

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/http-adapter.ts src/mcp/server.ts tests/mcp/http-adapter.test.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): add loom_submit_adhoc tool

Tool wraps POST /runs/adhoc with a project + prompt schema. Description
explains the loomforge-adhoc label and the create-issue-then-enqueue
flow so OpenClaw agents pick the right tool."
```

---

## Task 8: SKILL.md — document the ad-hoc flow

**Files:**
- Modify: `skills/loomforge/SKILL.md`

- [ ] **Step 1: Read the current skill structure**

```bash
sed -n '1,30p' skills/loomforge/SKILL.md
grep -n "^##" skills/loomforge/SKILL.md
```

Note the existing top-level sections (CLI Commands, Workflow States, Project Lifecycle, Setup, Design Flow, etc.) and the file's overall tone — match it.

- [ ] **Step 2: Add the Ad-hoc Run section**

Edit `skills/loomforge/SKILL.md`. Insert a new top-level section between "Project Lifecycle" and "Troubleshooting" (or wherever fits the existing flow — adjacent to the build-flow content):

```markdown
## Ad-hoc Run

Use ad-hoc when you have a small, well-scoped task and don't want to hand-author a Linear issue first. Loomforge creates the Linear issue from your prompt, then runs the normal build pipeline against it. The Linear issue is the system of record — it gets a `loomforge-adhoc` label, transitions through "in progress" / "done" like any other ticket, and closes when the run ships.

### When to use
- Quick fixes, refactors, doc tweaks — anything you'd describe in 1–3 sentences.
- Tasks too small to be worth opening a Linear ticket by hand.
- Anything OpenClaw decides to fire off without going through the planning flow first.

### When NOT to use
- A feature that needs decomposition into multiple tickets — use the planning flow.
- A project without Linear configured — ad-hoc requires `linearTeamKey` and `linearProjectName` in `loom.yaml`.

### CLI

```bash
loomforge run "Fix the typo in README" --project loom
loomforge run "Update the CHANGELOG for 0.3.0" --project /Users/me/code/loom
```

`--project` is **required** and accepts either a registered slug or an absolute path to the repo root. There is no CWD fallback — Loomforge is typically invoked by OpenClaw whose working directory is OpenClaw's repo, not the target project. Falling back to CWD would silently target the wrong repo.

The command prints the run ID, the synthesized Linear identifier, the Linear URL, and the queue position. Track the run with `loomforge get <runId>` like any other.

### MCP

```text
loom_submit_adhoc({
  project: "loom",
  prompt: "Fix the typo in README",
})
```

Returns the same payload as the CLI.

### What gets created in Linear

- One issue, titled with the first non-empty line of the prompt (truncated at 80 chars).
- Description = full prompt + a dated footer (`_Submitted via Loomforge ad-hoc on YYYY-MM-DD._`).
- Label `loomforge-adhoc` (created lazily on first submit per workspace).
- Placed in the team's `Backlog` workflow state. The engine then transitions it through "in progress" / "done" via the existing Linear status sync.

### Errors you might see

| Status | Error | What to do |
|---|---|---|
| 400 | `validation_failed` | Check the prompt is non-empty and ≤ 8000 chars; project must be a slug or absolute path. |
| 404 | `project_not_found` | Register the project in `~/.loomforge/loom.yaml` first. |
| 409 | `linear_not_configured` | Add `linearTeamKey` and `linearProjectName` to the project entry. |
| 502 | `linear_create_failed` (with `reason`) | Check Linear API key, team/project name, label permissions, or that a `Backlog` workflow state exists on the team. |
| 500 | `submit_after_create_failed` (with `orphanedIssueId`) | Linear issue was created but the local DB write failed. Inspect the issue manually or delete it; Loomforge does not auto-clean. |
```

- [ ] **Step 3: Run typecheck/lint just to be sure nothing else broke**

```bash
pnpm run typecheck && pnpm run lint
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/loomforge/SKILL.md
git commit -m "docs(skill): document adhoc run flow

Adds an Ad-hoc Run section covering when to use it, the CLI/MCP
surfaces, what gets created in Linear, and error handling. Calls out
that --project is required (no CWD fallback) and explains why."
```

---

## Task 9: README.md — add ad-hoc usage subsection

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README structure**

```bash
grep -n "^##\|^###" README.md
```

Note the section ordering: Usage → Issue build flow → Design flow → Reloading project config → MCP Server.

- [ ] **Step 2: Update the Table of Contents**

In the existing ToC under `## Table of Contents`, find:

```markdown
- [Usage](#usage)
  - [Issue build flow](#issue-build-flow)
  - [Design flow](#design-flow)
  - [Reloading project config](#reloading-project-config)
```

Change to:

```markdown
- [Usage](#usage)
  - [Issue build flow](#issue-build-flow)
  - [Ad-hoc run](#ad-hoc-run)
  - [Design flow](#design-flow)
  - [Reloading project config](#reloading-project-config)
```

- [ ] **Step 3: Add the Ad-hoc run subsection**

Locate the `### Issue build flow` section. Immediately after it (before `### Design flow`), insert:

````markdown
### Ad-hoc run

When you have a small, well-scoped task and don't want to hand-author a Linear issue, fire it off as an ad-hoc run. Loomforge creates a `loomforge-adhoc`-labeled Linear issue from your prompt, then runs the normal build pipeline against it. The Linear ticket is the system of record — it transitions through "in progress" / "done" exactly like a human-authored issue.

```bash
loomforge run "Fix the typo in README" --project loom
loomforge run "Update CHANGELOG for 0.3.0" --project /absolute/path/to/repo
```

`--project` is required and accepts either a registered slug or an absolute repo-root path. There is no current-directory fallback. The command prints the run ID, Linear identifier, and queue position; track it with `loomforge get <runId>`.

The project must have `linearTeamKey` and `linearProjectName` configured. See [skills/loomforge/SKILL.md](skills/loomforge/SKILL.md) for the full ad-hoc flow including MCP usage and error handling.
````

- [ ] **Step 4: Verify the document structure**

```bash
grep -n "^##\|^###" README.md
```

Expected: `### Ad-hoc run` appears between `### Issue build flow` and `### Design flow`. ToC entry exists.

- [ ] **Step 5: Run lint (in case formatter touches markdown)**

```bash
pnpm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): add adhoc run usage subsection

Documents \`loomforge run\` between the issue build flow and the design
flow, with a pointer to the skill for full detail. Updates the ToC."
```

---

## Task 10: Manual verification

**Files:** none (no commit)

This task is the smoke test against a real project. Skip it only if you cannot reach a Linear workspace.

- [ ] **Step 1: Start the daemon**

```bash
pnpm run build
node dist/cli/index.js start --config ~/.loomforge/loom.yaml
```

Or in dev mode against the local `loom.yaml` override:

```bash
pnpm run dev start --config $(pwd)/loom.yaml
```

- [ ] **Step 2: Submit an ad-hoc run**

In another terminal:

```bash
node dist/cli/index.js run "docs: fix a one-line typo in README" --project loom-test
```

Expected output (approximately):

```json
{
  "runId": "...",
  "issueId": "TEZ-...",
  "linearUrl": "https://linear.app/...",
  "queuePosition": 1
}
```

- [ ] **Step 3: Watch the run progress**

```bash
node dist/cli/index.js get <runId>
```

Expected: state transitions `queued` → `preparing_workspace` → `building` → `verifying` → `reviewing` → `ready_for_ship` → `shipped`.

- [ ] **Step 4: Verify Linear**

In Linear:
- The issue exists in the right project, with the `loomforge-adhoc` label.
- Title is the first line of your prompt.
- Description matches your prompt + the dated footer.
- Status moved through "in progress" → "done" as the run progressed.

- [ ] **Step 5: Verify the artifact directory**

```bash
ls $(pwd)/.loomforge-data/artifacts/<runId>/
```

Expected: standard build-run artifacts (`issue_snapshot.json`, builder/verifier/reviewer logs).

- [ ] **Step 6: Open a single PR for the full feature**

After steps 1–9 of this plan are committed and step 10 smoke-tested, open one PR against `main` with all the changes (per the project rule: one PR at the end of multi-task work, not intermediate PRs).

```bash
gh pr create --title "feat: ad-hoc prompt runs" --body "$(cat <<'EOF'
## Summary

Adds an ad-hoc submission path: send `{ project, prompt }` and Loomforge creates a `loomforge-adhoc`-labeled Linear issue, then runs the normal build pipeline against it. Reuses the existing engine end-to-end via a `source` discriminator on `RunRecord`.

Surfaces:
- HTTP: `POST /runs/adhoc`
- CLI: `loomforge run "<prompt>" --project <slug-or-path>` (--project required)
- MCP: `loom_submit_adhoc`

Spec: `docs/superpowers/specs/2026-04-26-adhoc-prompt-runs-design.md`
Plan: `docs/superpowers/plans/2026-04-26-adhoc-prompt-runs.md`

## Test plan
- [ ] `pnpm run typecheck && pnpm run test && pnpm run lint`
- [ ] Manual: `loomforge run "..." --project loom-test` produces a Linear issue, run flows to `shipped`, issue closes.
EOF
)"
```

---

## Self-review checklist (run before considering the plan done)

- [ ] **Spec coverage:** every requirement in the spec maps to at least one task above.
  - Project resolution (slug + absolute path) → Task 4 (orchestrator) + Task 5 (route schema).
  - Linear preconditions → Task 4.
  - Title derivation, dated footer, label, Backlog state → Task 3 (issue creation) + Task 4 (orchestrator wiring).
  - Engine `source` discriminator → Tasks 1, 2.
  - Error mapping → Task 4 (typed result) + Task 5 (HTTP status mapping).
  - CLI `--project` required, no CWD fallback → Task 6.
  - MCP tool → Task 7.
  - SKILL.md update → Task 8.
  - README update → Task 9.
- [ ] **No placeholders.** Every code block above is the actual code an engineer can paste.
- [ ] **Type consistency.** `RunSource`, `LinearAdhocClient`, `AdhocSubmitInput`, `AdhocSubmitResult`, `AdhocIssueError` names are used identically across all tasks.
- [ ] **Tests before code at every step that adds behavior.** Tasks 1–7 follow TDD. Tasks 8–10 are docs/manual and don't have failing-test gates.
- [ ] **Single PR at the end.** Each task commits locally; no intermediate PRs. Step 6 of Task 10 opens the one PR.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-adhoc-prompt-runs.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — A fresh subagent per task, with review between tasks. Fast iteration, tightest context per step.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, with checkpoints for review.

Pick one when ready to proceed.
