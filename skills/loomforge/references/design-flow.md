# Design Flow Reference

## What it does

The design flow turns a rough requirement into a reviewed design doc, a Linear
project + Document, and (for new projects with a remote) a registered
`loom.yaml` entry.

Pipeline (new project):

```
validate → scaffold dir + git init + .gitignore → gh repo create (optional)
→ copy CLAUDE.md/AGENTS.md → design-builder → design-reviewer
→ revise once if reviewer said 'revise' (no second review)
→ find-or-create Linear project → find-or-create Linear Document
→ append loom.yaml entry (only if remote is set)
→ emit handoff
```

For `design extend <slug> --feature <feature-slug>`:
- Skips scaffolding and `loom.yaml` registration.
- Writes to `docs/design/<slug>-<feature-slug>-design.md`.
- Creates a new Linear Document titled `<slug>-<feature-slug>` attached to the
  same Linear project.

## Naming convention

One canonical form everywhere: lowercase, hyphen-separated
(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`).

- `slug` — project slug and `loom.yaml` key.
- `feature-slug` — feature identifier for `extend`.
- Repo dir: `<repoRoot>/<slug>/`.
- Design doc: `docs/design/<slug>-design.md` (new) or
  `docs/design/<slug>-<feature-slug>-design.md` (extend).
- Linear project name: same as `slug`.
- Linear Document title: same as `slug` (new) or `<slug>-<feature-slug>` (extend).
- GitHub repo name: same as `slug`.

Inputs that don't match the pattern are rejected at every boundary (CLI, HTTP,
MCP).

## Templates

Two templates live at the Loomforge package root:

- `templates/CLAUDE_TEMPLATE.md` — copied into new repos as both `CLAUDE.md`
  and `AGENTS.md`. Codex fills placeholders (`{Project Name}`) automatically
  during scaffolding.
- `templates/DESIGN_TEMPLATE.md` — required section structure for the design
  doc. The design-builder prompt points Codex at this file and tells it to
  replace every instructional paragraph with real content.

If reviewers flag leftover `{placeholder}` or template meta-instructions, the
design-builder is instructed to replace (not copy through) on the next run.

## Failure reasons

| Reason | Meaning | Recovery |
|---|---|---|
| `invalid_input` | slug / feature / requirement failed validation | fix the input |
| `scaffolding_failed` | dir, git init, or template copy failed | check disk / permissions |
| `runner_error` | design-builder/runner crashed or emitted no markers | `loomforge design retry <id>` |
| `runner_auth_missing` | Codex or Claude CLI not authenticated | re-authenticate, then retry |
| `design_empty_output` | design doc missing, empty, or heading-less | add `--redraft` on retry |
| `design_review_blocked` | reviewer returned `blocked` | inspect artifact logs, then retry |
| `linear_team_missing` | configured `design.linearTeamKey` doesn't exist in Linear | fix config |
| `design_linear_conflict` | multiple or archived Linear projects with the same name | clean up in Linear, then retry |
| `design_document_conflict` | Linear Document with the same title exists but isn't ours | delete/rename in Linear, then retry |
| `project_not_found` | `design extend` couldn't find the parent Linear project | run `design new` first |
| `registration_failed` | Linear API error while creating/updating the Document | retry |

## Retry semantics

All state lives in `design_runs` keyed on `(slug, feature)`. Every step
persists its IDs, so:

- `loomforge design retry <id>` resumes from the last incomplete step.
- Re-running `design new <slug>` with the same slug reconciles against the
  existing run (same ID).
- `--redraft` clears `design_doc_sha`, `review_outcome`, and
  `linear_document_id` so the pipeline re-executes from step 6 (drafting).
- Name-based Linear lookups only run on the first execution of steps 9/10;
  after that, stored IDs are authoritative, so renaming a project or document
  in Linear will not break subsequent retries.

## Generated `loom.yaml` entry

On `design new`, if the repo has a remote, the pipeline appends:

```yaml
- slug: <slug>
  repoRoot: <repoRoot>/<slug>
  defaultBranch: main
  devBranch: dev
  linearTeamKey: <team>
  linearProjectName: <slug>
  builder: codex
  reviewer: claude
  verification:
    commands:
      - name: placeholder
        command: "echo 'TODO: replace with real verification command in ~/.loomforge/loom.yaml'"
```

**The `verification.commands` are a placeholder.** Edit them before submitting
any build issues — the build workflow runs them unconditionally.

If the repo has no remote yet, `registration: needs_remote` is returned in the
handoff instead. Set up a remote manually (`gh repo create` or a remote of
your choice), then re-run.

## Artifacts

All stdin/stdout/stderr for the builder and reviewer subprocesses are written
to `<dataRoot>/design-artifacts/<designRunId>/`. Check those when diagnosing
`runner_error` or `design_empty_output`.
