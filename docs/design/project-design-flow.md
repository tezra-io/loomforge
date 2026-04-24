# Project Design Flow

## At a glance
```
  CLI  /  HTTP  /  MCP
          │
          │   loomforge design new <slug>  --requirement-(path|text) …
          │   loomforge design extend <slug> --feature <feature-slug> …
          ▼
  ┌─────────────────────────────────────────────┐
  │ Loomforge daemon — design pipeline          │
  │                                             │
  │   1  validate inputs                        │
  │   ─────────────────────────────────         │
  │   2  scaffold <repoRoot>/<slug>/    ──▶ local fs
  │   3  git init + .gitignore          ──▶ git
  │   4  gh repo create (if available)  ──▶ gh (optional)
  │   5  copy AGENTS.md / CLAUDE.md     ──▶ local fs
  │   ─────────────────────────────────         │
  │   6  design-builder                 ◀─▶ Codex harness
  │   7  design-reviewer                ◀─▶ Claude harness
  │   8  revise (≤ 1 cycle, if reviewer said 'revise')
  │   ─────────────────────────────────         │
  │   9  find-or-create Linear project  ──▶ Linear API
  │  10  find-or-create Linear Document ──▶ Linear API
  │   ─────────────────────────────────         │
  │  11  append to ~/.loomforge/loom.yaml       │
  │      (only if remote_url set;              │
  │       otherwise emit 'needs_remote')        │
  │  12  handoff record                         │
  │                                             │
  │  every step persists state + artifact IDs   │
  │  in SQLite:  design_runs (slug, feature,    │
  │  state, linear_project_id, …)               │
  └─────────────────────────────────────────────┘
          │
          ▼
  handoff: { designRunId, localDocPath, linearProjectUrl,
             linearDocumentUrl, registered | needs_remote, notes }
```

Retries resume from the last incomplete step using the persisted IDs; `--redraft` clears `design_doc_sha` and downstream fields so the pipeline re-executes from step 6.

## Problem
The current Loomforge workflow starts from an already-scoped Linear issue and drives it through build → verify → review → push. It assumes the design work already happened somewhere else. In practice, the step *before* that — turning a rough requirement into (a) a reviewed design doc, (b) a Linear project, and (c) a repo that Loomforge can run against — is still manual. That pre-work is slow, inconsistent across projects, and the artifacts (design docs, templates, conventions) drift.

## Goal
A separate Loomforge command surface that takes a user-provided requirement and produces:

1. A new or updated local repo, scaffolded with the project's standard governance files (AGENTS.md, CLAUDE.md, `.gitignore`). GitHub remote is created only if the local `gh` CLI is installed and authenticated.
2. A design doc drafted by the Codex builder against a fixed template, with Codex doing any research itself based on the requirement.
3. A Claude reviewer pass on the draft. At most one revision cycle: if the reviewer says `revise`, Codex applies the findings; the revised doc is not re-reviewed in this run. The user can re-run manually for further iterations.
4. A Linear project (new) with the design doc attached as a Linear Document; or for `extend`, a new Linear Document attached to the existing Linear project.
5. A Loomforge project entry in `~/.loomforge/loom.yaml` *if the project is fully ready for the build workflow* (has a git remote). Otherwise registration is deferred.

The pipeline runs to completion without a human gate. User follow-up is reviewing the doc in Linear, editing it if needed, and creating Linear issues.

## Non-goals
- Writing or scoping individual Linear issues from the design doc.
- Running the builder against code. This command stops at "design is published."
- Replacing the existing build workflow's review loop.
- Replacing OpenClaw's planning chat.

## Command surface
Distinct from the execution flow:

```
loomforge design new <slug>
  (--requirement-path <file> | --requirement-text <string>)
  [--repo-root <path>]
  [--redraft]

loomforge design extend <slug>
  --feature <feature-slug>
  (--requirement-path <file> | --requirement-text <string>)
  [--redraft]
```

Mirrored MCP tools:

- `loom_design_new_project({ slug, requirementPath?, requirementText?, repoRoot?, redraft?, executionMode })`
- `loom_design_extend_project({ slug, feature, requirementPath?, requirementText?, redraft?, executionMode })`
- `loom_get_design_run({ designRunId })`
- `loom_cancel_design_run({ designRunId })`
- `loom_retry_design_run({ designRunId })`
- `loom_get_design_run_status_for_project({ slug })` — mirrors `loom_get_project_status`

Mirrored HTTP under `/design/`: `POST /design/new`, `POST /design/extend`, `GET /design/:id`, `POST /design/:id/cancel`, `POST /design/:id/retry`.

### Input rules
- Exactly one of `--requirement-path` or `--requirement-text` must be provided (enforced at CLI, HTTP, and MCP layers).
- `--requirement-path` is an absolute path on the daemon machine. When called via MCP from a local OpenClaw, the caller provides a daemon-resolvable path.
- `slug` matches `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` (identical to `src/config/index.ts:10`).
- `--feature` matches the same slug pattern. Used for the Linear Document title, the local file name, and as an idempotency key on `extend`.
- `--redraft` forces a fresh draft even if a prior draft exists for this run. Without it, retry reuses the prior draft and goes straight to review (or skips review if the prior run got past review).

## Flow (new project)
A durable run on the Loomforge daemon, mirroring execution runs. Each step persists its outcome and the durable artifact IDs (see **design_runs persistence**) so retries resume from the last incomplete step.

| # | Step | State | Persisted artifact |
|---|---|---|---|
| 1 | Validate inputs. If `slug` exists on disk or in `loom.yaml` or in `design_runs`, resolve to the existing run and enter reconcile mode. | `validating` | — |
| 2 | Ensure project dir at `<repoRoot>/<slug>/`. | `scaffolding` | `repo_path` |
| 3 | Ensure `git init` + initial commit. Write `.gitignore` that includes `docs/design/<slug>-design.md`. Commit if changed. | `scaffolding` | — |
| 4 | If `gh` CLI present and authenticated, `gh repo create` and push initial commit. Record remote URL. | `scaffolding` | `remote_url` |
| 5 | Copy `templates/CLAUDE_TEMPLATE.md` into the repo as both `CLAUDE.md` and `AGENTS.md` (same source, two destinations — AGENTS.md is the open-standard alias). Commit if changed. | `scaffolding` | — |
| 6 | Design-builder runner writes `docs/design/<slug>-design.md`. | `drafting` | `design_doc_path`, `design_doc_sha` |
| 7 | Design-reviewer runner reads the draft and returns `pass` \| `revise` \| `blocked`. | `reviewing` | `review_outcome`, `review_findings` |
| 8 | If `revise`, design-builder runs once more with findings fed back. No second review. If `blocked`, fail with `design_review_blocked`. | `revising` (if applicable) | updated `design_doc_sha` |
| 9 | Find-or-create Linear project by configured name. Conflict rules below. | `publishing` | `linear_project_id` |
| 10 | Find-or-create Linear Document. Conflict rules below. | `publishing` | `linear_document_id` |
| 11 | **Only if `remote_url` is set**: append project entry to `~/.loomforge/loom.yaml`. Otherwise emit `needs_remote` in the handoff and skip registration. | `registering` | — |
| 12 | Emit handoff record. | `complete` | — |

No rollback on failure. Partial state persists and retries pick up from the last incomplete step using the stored IDs.

## Flow (extend existing project)
- Input: `<slug>` (must resolve via `loom.yaml`) + `--feature <feature-slug>`.
- Skips steps 2–5 and step 11.
- Step 6 writes to `docs/design/<slug>-<feature-slug>-design.md`. Updates `.gitignore` to include the new file.
- Step 9 looks up the existing Linear project via the persisted `linear_project_id` on the project's prior design run (or the project's linearProjectName config fallback).
- Step 10 creates a new Linear Document with title `<slug>-<feature-slug>` attached to the same Linear project. Never attaches to a separate sub-project.

Feature-slug is the idempotency key: re-running `design extend <slug> --feature <same-feature>` reconciles against the existing run for that slug+feature pair.

## Generated `loom.yaml` entry
The registration step (step 11) appends a full valid project entry that satisfies `projectConfigSchema` in `src/config/index.ts`. Concretely:

```yaml
- slug: <slug>
  repoRoot: <repoRoot>/<slug>
  defaultBranch: main              # from config.design.defaultBranch
  devBranch: dev                   # from config.design.devBranch (optional)
  linearTeamKey: <team>            # from config.design.linearTeamKey
  linearProjectName: <slug>        # always equals slug (see Naming convention)
  builder: codex
  reviewer: claude
  verification:
    commands:                      # placeholder — see note below
      - name: placeholder
        command: "echo 'TODO: replace with real verification command in ~/.loomforge/loom.yaml'"
```

**Verification commands are a placeholder in V1.** The daemon requires `verification.commands` to be `.nonempty()`, so we can't omit it, but we also can't synthesize real ones. The handoff explicitly flags this and points the user at the entry to edit before submitting any issues. (Future work: teach the design-builder to propose a verification section in the doc and parse it into the config. Deferred — makes V1 bigger than it needs to be.)

## Config
Extend `~/.loomforge/config.yaml`:

```yaml
design:
  repoRoot: ~/projects             # default parent dir for new repos
  defaultBranch: main
  devBranch: dev                   # optional
  linearTeamKey: TEZ               # default team for new Linear projects
```

## Naming convention
One canonical form is used across all surfaces: **lowercase, hyphen-separated** (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`). No spaces, no underscores, no camelCase, no uppercase. Concretely:

- `slug` (CLI arg, loom.yaml key, internal identifier).
- `feature-slug` (CLI arg for extend).
- Target repo directory: `<repoRoot>/<slug>/`.
- Design doc filename: `docs/design/<slug>-design.md` (new) or `docs/design/<slug>-<feature-slug>-design.md` (extend).
- Linear project name: same as `slug` (e.g. `my-app`, not `My App`).
- Linear Document title: same as `slug` (new) or `<slug>-<feature-slug>` (extend).
- GitHub repo name (when `gh repo create` runs): same as `slug`.

This is not configurable. `linearProjectNameTemplate` is intentionally omitted — it would let the Linear project name drift from the slug, and lookup/conflict detection relies on name == slug. If the user wants a prettier display name in Linear, they rename it in Linear after creation; our future lookups use `linear_project_id` so the rename doesn't break them.

Inputs that don't match the pattern are rejected at the CLI / HTTP / MCP boundary with a clear error — we don't "slugify" user input, we make them provide the canonical form.

## `design_runs` persistence
New SQLite table, separate from `runs` so schemas stay clean:

```sql
CREATE TABLE design_runs (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL,
  feature                TEXT,                   -- null for 'new', set for 'extend'
  kind                   TEXT NOT NULL,          -- 'new' | 'extend'
  state                  TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  requirement_source     TEXT NOT NULL,          -- 'path' | 'text'
  requirement_ref        TEXT NOT NULL,          -- the path or the text
  repo_path              TEXT,
  remote_url             TEXT,
  design_doc_path        TEXT,
  design_doc_sha         TEXT,
  linear_project_id      TEXT,
  linear_document_id     TEXT,
  review_outcome         TEXT,                   -- 'pass' | 'revise' | 'blocked'
  review_findings_json   TEXT,
  failure_reason         TEXT,
  completed_at           INTEGER,
  UNIQUE (slug, feature)                         -- enforces one active run per (slug, feature) pair
);
```

All idempotency/resume decisions use the persisted IDs, not name lookups:
- Re-run for `(slug, feature=null)` on `new` → load the row; if `linear_project_id` is set, skip step 9; if `linear_document_id` is set, skip step 10; etc.
- `--redraft` clears `design_doc_sha` (and downstream fields) so the pipeline re-executes from step 6.

Name-based lookups are used only on *first* execution of step 9/10 to detect a pre-existing resource the user may have created by hand; once found, the ID is persisted and all subsequent work uses the ID.

## Design runner contract
The design runner is a **separate runner** from the code builder. It shares the `runProcess` primitive and the `agentCommand` helper (Codex/Claude invocation), but has distinct success semantics:

- Design-builder success criteria (NOT dependent on git):
  - Stdout contains `DESIGN_DOC_PATH: <path>`.
  - File at that path exists.
  - File is non-empty markdown (> N bytes, has at least one heading).
  - Stdout ends with `SUMMARY: <text>`.
- Failure semantics: no `DESIGN_DOC_PATH` emitted → `runner_error`. Path missing on disk → `runner_error`. File empty → `design_empty_output`. Auth failure → `runner_auth_missing` (reuse `isRunnerAuthError`).
- No `CHANGED_FILES` contract, no auto-commit attempt, no `headBefore/headAfter` comparison.

Design-reviewer uses the existing reviewer JSON output contract verbatim (`outcome: pass | revise | blocked`, `findings`, `summary`) so the revision loop reuses existing parse code.

The design-builder prompt (`src/runners/prompts/design-builder.ts`, mirroring `src/runners/prompts/builder.ts`) must be explicit that Codex fills the template by:
- Reading `templates/DESIGN_TEMPLATE.md` as the required section structure.
- **Replacing** the instructional prose in each section with the content it describes, not copying the instructions through.
- **Replacing** every `{placeholder}` and `<!-- HTML comment -->` in `CLAUDE_TEMPLATE.md` (when also drafting project governance files) with real content, and deleting the template-use header lines.
- Producing a fully valid markdown file with no leftover meta-instructions.

The design-reviewer prompt must assert these same invariants in its findings (any leftover placeholder or instructional prose → `revise`).

Implementation-wise: `src/runners/design-builder-runner.ts` and `src/runners/design-reviewer-runner.ts` alongside the existing runners, both implementing minimal interfaces used by `src/design/engine.ts`. No changes to `codex-builder-runner.ts` or `claude-reviewer-runner.ts`.

## Linear publishing rules
### Step 9: Linear project
- Lookup order: (a) `linear_project_id` from `design_runs`, (b) `linearProjectName` match in `loom.yaml` resolved to an ID, (c) exact name match via Linear API.
- If exact name match returns multiple projects, or the match is archived: **fail** with `design_linear_conflict`. User resolves by providing `linearProjectId` override (future flag) or cleaning up in Linear.
- If team doesn't exist: fail with `linear_team_missing`.
- Creating a new project: `name = slug` (see Naming convention). Record the returned ID.

### Step 10: Linear Document
- Lookup: `linear_document_id` from `design_runs`.
- If set: **update** the existing document with current design doc content (preserves the user's URL link in Linear across redrafts).
- If not set: **create** a new document with title `<slug>` (new) or `<slug>-<feature-slug>` (extend).
- If a document with the same title already exists on the project but our `linear_document_id` is null: **fail** with `design_document_conflict` and surface the existing document URL. User resolves — we never touch a document we don't own.
- User edits to a published document are preserved only to the extent Linear's API preserves them. Our update replaces content wholesale; future work could diff-merge but V1 is whole-content replace.

## MCP server
New tools in `src/mcp/server.ts` mirror the execution tools' shape:

| Tool | Purpose |
|---|---|
| `loom_design_new_project` | Start a new-project design run |
| `loom_design_extend_project` | Start an extend design run |
| `loom_get_design_run` | Fetch current state, findings, handoff |
| `loom_cancel_design_run` | Cancel a queued or active design run |
| `loom_retry_design_run` | Retry a failed/stuck design run |
| `loom_get_design_run_status_for_project` | Project-level completion status |

All tools prefixed `loom_design_*` for consistency with `loom_*` execution tools. No `design_new_project`-style tool names.

Design-run IDs are distinct from execution-run IDs (different ID namespace, different table).

## Skill
`skills/loomforge/SKILL.md` updates:

1. Add a top-level *Design Flow* section covering:
   - One-paragraph summary.
   - CLI commands (`loomforge design new`, `loomforge design extend`) with input rules.
   - MCP tool names and when to prefer each.
   - State machine (`validating → scaffolding → drafting → reviewing → revising? → publishing → registering → complete`).
   - Handoff shape (local path, Linear URLs, possible `needs_remote` flag).
   - Retry semantics (resume by slug+feature; `--redraft` forces fresh draft).
2. Update `description` front matter so the skill matcher triggers on design/scoping language.
3. Add `skills/loomforge/references/design-flow.md` for troubleshooting and template details.

## Reused primitives (no new packages)
Every bash / subprocess / filesystem / git / Linear call in this flow goes through tooling the build workflow already ships. **No new runtime dependencies are added.** Concretely:

| Task | Primitive already in repo | Where |
|---|---|---|
| Run a subprocess with logged stdout/stderr and artifact capture (Codex, Claude runs) | `runProcess(options)` | `src/runners/process-runner.ts:27` |
| Build the Codex / Claude CLI invocation | `agentCommand(tool)` | `src/runners/codex-builder-runner.ts:319` |
| Detect auth failure from runner stderr | `isRunnerAuthError(stderr)` | `src/runners/process-runner.ts:81` |
| Expand PATH for spawned subprocesses | `childProcessEnv()` | `src/runners/path-env.ts` |
| Run git commands (`init`, `add`, `commit`, `remote add`, `push`) | `execa("git", [...])` | matches pattern in `src/worktrees/git-workspace-manager.ts` |
| Run `gh` commands (`repo create`, `auth status`) | `execa("gh", [...])` | matches pattern in `src/worktrees/pull-request-creator.ts` |
| Subprocess timeouts | `src/runners/timeout.ts` | existing |
| Linear API calls | `@linear/sdk` LinearClient, wrapped by `src/linear/linear-workflow-client.ts` | existing; we add methods to the same class, not a second client |
| SQLite access | existing `src/db/` repositories + migration pattern | existing |
| YAML parse/write for `loom.yaml` append | `yaml` (already in deps, used by `src/config/`) | existing |
| Config loading | `src/config/index.ts` (extended with the `design:` section) | existing |

`src/scaffolding/` is new code but **no new dependencies**: it composes `execa` (already present) + `node:fs/promises` + the existing template file copy pattern.

The design-builder and design-reviewer runners are new files but their **implementation is a thin variant of `codex-builder-runner.ts` / `claude-reviewer-runner.ts`** — same `runProcess` + `agentCommand` + `isRunnerAuthError` primitives, different success-contract parsing (see **Design runner contract**). Do not introduce a parallel subprocess layer.

If implementation discovers a primitive is missing (e.g. a common "git wrapper" that the worktrees manager would also benefit from), **extract it into a shared module** rather than duplicating — but still no new package.

## Subsystems affected
New:
- `src/design/` — pipeline engine, state machine, persistence.
- `src/scaffolding/` — dir, git init, `.gitignore`, `gh` detection, template copy.
- `src/runners/design-builder-runner.ts`, `src/runners/design-reviewer-runner.ts`.
- `src/runners/prompts/design-builder.ts`, `src/runners/prompts/design-reviewer.ts` (following the existing `prompts/builder.ts` / `prompts/reviewer.ts` pattern — exported `buildPrompt(context)` functions, not standalone `.md` files).
- `templates/` at repo root — `CLAUDE_TEMPLATE.md`, `DESIGN_TEMPLATE.md` (present). `CLAUDE_TEMPLATE.md` is copied into target repos as both `CLAUDE.md` and `AGENTS.md`; no separate AGENTS template.
- `package.json` `files`: add `templates/`.

Extended:
- `src/linear/linear-workflow-client.ts` — add `findProjectById`, `findProjectByName`, `createProject`, `findDocumentOnProject`, `createDocumentOnProject`, `updateDocument`.
- `src/mcp/server.ts` — new tools listed above.
- `src/api/` — new `/design/*` routes.
- `src/cli/` — `design new` and `design extend` subcommands.
- `src/db/` — migration for `design_runs` table.
- `src/config/index.ts` — parse the new `design:` section.

Unchanged:
- `src/runners/codex-builder-runner.ts`, `src/runners/claude-reviewer-runner.ts`.
- `src/workflow/engine.ts`.
- `src/worktrees/`.
- All existing execution-run behavior.

## Assumptions
- Runs for this flow are a distinct run kind but reuse the same daemon, SQLite, artifact directory, and runner process abstractions.
- Codex and Claude remain the only builder/reviewer implementations.
- GitHub is the only optional remote host.
- Requirement input is markdown/text.
- Single-user, single-machine.
- In the *target* repo, the design doc lives at `docs/design/<slug>-design.md`. Whether the target repo tracks or gitignores that path is up to the target repo; the flow works either way because Codex and Claude operate on the local file and Linear holds the canonical shared copy.

## Sequencing
Shippable build order:

1. Commit this design doc as the implementation spec.
2. `templates/` scaffolding (stub files) + `package.json` `files` update. User drops real templates afterwards.
3. `src/db/` migration for `design_runs`. `src/design/` engine skeleton + state machine + persistence + CLI subcommand stubs.
4. `src/scaffolding/` (dir + git + `.gitignore` + template copy). `loomforge design new <slug>` works end-to-end up to step 5 (no Codex/Linear yet).
5. Design-builder runner + prompt. End-to-end up to step 6.
6. Design-reviewer runner + prompt + single-revision loop. End-to-end up to step 8.
7. Linear adapter extensions + publishing rules (step 9, 10). End-to-end up to step 10.
8. `loom.yaml` appender with full project-entry generation (step 11 guarded on remote). `new` happy path complete.
9. `design extend` variant + `--feature` arg.
10. MCP tools + HTTP routes.
11. Skill update: `SKILL.md` + `references/design-flow.md`.
12. `gh` CLI detection + optional remote create (can slot earlier once 4 works).
13. Idempotency/retry polish using persisted IDs.
