# Project Planning Flow

## At a glance
```
  CLI  /  HTTP  /  MCP
          │
          │   loomforge plan <project-slug>
          ▼
  ┌─────────────────────────────────────────────┐
  │ Loomforge daemon — planning pipeline        │
  │                                             │
  │   1  resolve project from registry          │
  │   2  verify design doc exists locally       │
  │      verify Linear project ID is set        │
  │   ─────────────────────────────────         │
  │   3  ensure '.loomforge/' is gitignored     │
  │      create plan_run row (SQLite)           │
  │   4  spawn Codex in repo root      ◀─▶ Codex harness
  │      (--approval-mode full-auto;            │
  │       writes ONE file to                    │
  │       <repoRoot>/.loomforge/plan-output.json)│
  │   5  read plan-output.json from disk,       │
  │      JSON.parse + shape-validate            │
  │   ─────────────────────────────────         │
  │   6  for each issue: Linear issueCreate ──▶ Linear API
  │      under the project's Linear project     │
  │   7  move plan-output.json into artifact    │
  │      dir; persist results; mark plan_run    │
  │      complete | partial | failed            │
  │                                             │
  │  artifacts: <dataRoot>/artifacts/<plan-id>/ │
  │    prompt.md, codex-stdout.log,             │
  │    codex-stderr.log,                        │
  │    plan.json, linear-results.json           │
  └─────────────────────────────────────────────┘
          │
          ▼
  handoff: { planRunId, projectSlug, created: [{linearId, identifier, title}],
             failed: [{title, reason}], summary }
```

## Problem
The design flow ends at "design doc published in Linear." The build flow starts from a scoped Linear issue. Between the two, someone has to read the design doc and turn it into a set of issues, sized roughly per-feature, with acceptance criteria detailed enough that the Codex builder can act on them unattended.

In practice this is done by hand or in OpenClaw chat. Two problems with that:
- **Context.** OpenClaw doesn't see the codebase. A Codex run inside the repo can ground the breakdown in code that already exists, naming conventions, and the actual module layout.
- **Continuity.** Loomforge already owns the rest of the lifecycle (design → build → PR). Putting planning in OpenClaw keeps a manual seam in the middle.

## Goal
A pipeline that takes one input (`project-slug`) and produces a set of Linear issues attached to that project's Linear project, ready for the build flow to pick up.

The pipeline:
1. Reads the project's design doc from the configured local path.
2. Spawns Codex inside the project's repo so it can ground the breakdown in real code.
3. Receives a JSON breakdown of feature-sized issues, each with title, description, acceptance criteria, complexity.
4. Creates Linear issues under the project's Linear project, mapping complexity → estimate.
5. Persists artifacts and a summary handoff.

The breakdown is auto-applied. If the operator dislikes the result, they delete the issues in Linear and rerun.

## Non-goals
- Editing the design doc or generating new design content.
- Computing dependency graphs between issues, ordering them, or assigning priorities.
- Idempotency or "diff against existing issues" logic. Re-running creates duplicates.
- Multi-pass planning (outline → expand). Single Codex pass.
- Letting Codex modify the codebase. Codex is read-only on source files; the *only* file it writes is `.loomforge/plan-output.json` (see "Codex contract" below). All other side effects are Linear issue creation and artifacts under `<dataRoot>`.
- Replacing OpenClaw planning chat for projects without a design doc.

## Command surface
```
loomforge plan <project-slug>
  [--design-doc <relative-path>]   # override the project's configured design doc path
  [--max-issues <n>]               # default: 12
  [--dry-run]                      # run Codex, write plan.json, do NOT create Linear issues
```

Mirrored MCP tool:
```
loomforge_plan_design({
  projectSlug: string,
  designDocRelativePath?: string,
  maxIssues?: number,
  dryRun?: boolean,
})
```

## Inputs / preconditions
The project must already be registered in `~/.loomforge/loom.yaml` and have:
- `repoRoot` — Codex runs here.
- `designDocRelativePath` — set by the design flow; can be overridden via `--design-doc`.
- `linearProjectName` — resolved to a Linear project ID at run time.
- `linearTeamKey` — required for Linear issue creation.

If any of these are missing, the run fails fast with a `precondition_failed` reason and a clear `summary` message. No partial Codex run.

## Codex contract
Codex writes a single JSON file to a fixed path inside the repo. **It does not emit the JSON to stdout.** Stdout is captured for forensics only — Loomforge never parses it.

**Output path:** `<repoRoot>/.loomforge/plan-output.json`

Why a file and not stdout: harness wrappers add banners, status lines, and ANSI noise; long stdouts can be truncated. A direct file write avoids all of it. Why inside the repo: Codex full-auto only writes inside its cwd by default; writing to `<dataRoot>` (outside the repo) would trigger a sandbox permission prompt and break the unattended contract. Loomforge moves the file into `<dataRoot>/artifacts/<plan-run-id>/plan.json` after Codex exits.

`.loomforge/` must be gitignored before Codex runs. Step 3 of the pipeline checks the project's `.gitignore` and appends `.loomforge/` if missing — same pattern as `ensureGitignore` in the design scaffold.

**File contents:**
```json
{
  "issues": [
    {
      "title": "Short imperative title (≤ 80 chars)",
      "description": "Markdown body. Include: what this issue covers, why it exists in this design, any non-obvious context the builder will need from the codebase.",
      "acceptance_criteria": [
        "Specific, testable outcome 1",
        "Specific, testable outcome 2"
      ],
      "complexity": "S | M | L | XL"
    }
  ],
  "summary": "One paragraph on how the design doc was decomposed."
}
```

The Codex prompt instructs:
- Read `<design-doc-path>` in full before producing any output.
- Walk the repo (read-only) to ground the breakdown in existing code. **Do not modify any source file.**
- Write the final JSON to `.loomforge/plan-output.json` (relative to repo root). Create the `.loomforge/` directory if it does not exist. Do not write any other files. Do not emit the JSON on stdout.
- Emit **4 to `--max-issues` issues** total. Combine setup + implementation + tests for the same feature into one issue, not three.
- Each issue should be 1–5 days of focused work.
- No issue should depend on another being half-done; each should be independently buildable from the design doc.

**Failure modes (all explicit, no recovery heuristics):**
- File missing after Codex exits → `output_missing`.
- File exists but `JSON.parse` fails → `parse_failed` (record file size + first 500 chars in the run row for debugging).
- JSON parses but shape invalid (missing fields, wrong types, bad complexity values) → `invalid_shape`.
- Issue array empty or larger than `--max-issues` → `out_of_bounds`.

The parser is small: `JSON.parse` + a Zod (or hand-rolled) shape guard. None of the balanced-brace extraction or truncation recovery from `review-output-parser.ts` is needed here.

## Linear mapping
For each issue in `plan.issues`:
- `title` → Linear `title`
- `description` → Linear `description`, with acceptance criteria appended as a `## Acceptance Criteria` markdown section. One body field, not a separate AC field.
- `complexity` → Linear `estimate`:
  - `S` → 1
  - `M` → 3
  - `L` → 5
  - `XL` → 8
- `projectId` → resolved Linear project ID
- `teamId` → resolved from `linearTeamKey`
- `state` → project's "backlog" workflow state (looked up by name; configurable in `loom.yaml` under `linearStatuses.planBacklog` if needed)

If an `issueCreate` call fails (rate limit, auth, schema mismatch), record the failure under `failed[]` and continue with the rest. Final run state is `partial` if at least one succeeded and one failed, `complete` if all succeeded, `failed` if none succeeded.

## State & artifacts
SQLite (reuse the run table with a discriminator):
```
runs
  id, run_type='plan', project_slug, status, started_at, ended_at, error
plan_run_issues
  plan_run_id, sequence, title, complexity, linear_issue_id (nullable), linear_identifier (nullable), error (nullable)
```

Filesystem under `<dataRoot>/artifacts/<plan-run-id>/`:
- `prompt.md` — the rendered Codex prompt (design doc inlined, instructions, output schema, output path).
- `codex-stdout.log` — captured Codex stdout (forensics only; never parsed).
- `codex-stderr.log` — captured Codex stderr.
- `plan.json` — moved here from `<repoRoot>/.loomforge/plan-output.json` after Codex exits successfully. The repo-side temp file is deleted in the same step.
- `linear-results.json` — `{created: [...], failed: [...]}`.

If Codex fails (non-zero exit, output missing, parse error), `<repoRoot>/.loomforge/plan-output.json` is left in place so the operator can inspect it, and the path is recorded in the run row's `error` field. The next plan run for the same project deletes any stale `.loomforge/plan-output.json` before spawning Codex.

## Decisions
1. **Auto-create, not preview-then-confirm.** One step. If output is bad, operator deletes issues in Linear and reruns. `--dry-run` exists for ad-hoc debugging, not as the standard flow.
2. **No idempotency.** Re-running creates duplicates. Add later if it proves painful in practice.
3. **File output, not stdout.** Codex writes `.loomforge/plan-output.json` inside the repo (its cwd, no sandbox prompt). Loomforge moves it to `<dataRoot>/artifacts/...` after exit. Avoids harness stdout noise, ANSI codes, and the truncation issues that forced `recoverTruncatedJson` in the reviewer parser.
4. **Read-only on source.** Codex must not modify any source file. The single permitted write is `.loomforge/plan-output.json`. The pipeline pre-stages `.loomforge/` in `.gitignore` so the temp file never appears as a tracked change.
5. **One Codex pass.** No outline-then-expand. Keeps the runner simple and the prompt single-purpose.
6. **Single body field, not split AC.** Acceptance criteria live inside the Linear description as a markdown section. Avoids a separate Linear field mapping that varies between workspaces.
7. **Reuse the existing run table, discriminate with `run_type`.** Avoids a parallel schema for what is structurally similar to a build run.

## Open risks
- **Codex output quality is the biggest unknown.** A vague design doc produces vague issues. The repo-grounding helps but isn't a substitute for a thin spec. Watch the first few real runs and tune the prompt before adding any structural complexity.
- **Linear schema drift.** If the configured Linear workspace doesn't have an estimate field or a "Backlog" state, creation will fail. Validate at run start, not mid-loop.
- **Two reasons to spawn Codex now (builder, planner).** If a third appears, factor a thin shared invocation in `src/runners/codex.ts`. Don't pre-factor — duplication is fine for two call sites.
- **No diff support.** If the design doc evolves, planning over the new version creates a fresh set of issues with no awareness of what already exists. Acceptable for v1; reconsider only if it bites.

## Implementation order
Build in this order. Each step has tests before code.

1. `src/runners/planner-output-parser.ts` — `JSON.parse` + shape guard for `.loomforge/plan-output.json`. Tests cover happy path, malformed JSON, empty array, oversize array, missing fields, bad `complexity` enum value, missing file. **No** balanced-brace extraction or truncation recovery.
2. `src/runners/planner.ts` — Codex harness invocation (full-auto). Pre-creates `<repoRoot>/.loomforge/`, deletes any stale `plan-output.json`, runs Codex with the prompt that names the output path, then reads + parses the file. Returns parsed plan or `RunFailure`.
3. `src/db/plan-runs.ts` — repository for `runs` (with `run_type='plan'`) and `plan_run_issues`.
4. `src/linear/issue-create.ts` — thin wrapper over `@linear/sdk` `issueCreate`. Maps complexity → estimate; appends AC markdown to body.
5. `src/workflow/planning.ts` — orchestrator. Resolves project, validates preconditions, calls planner, iterates Linear creation, writes artifacts, finalizes run state.
6. `src/cli/program.ts` — `loomforge plan <slug>` command.
7. `src/api/` — `POST /plans` route delegating to `workflow/planning`.
8. `src/mcp/` — `loomforge_plan_design` tool.

Stop after step 5 + manual run against `loom-test`. Only ship the CLI/HTTP/MCP surface once the engine has produced a usable breakdown end-to-end on a real design doc.
