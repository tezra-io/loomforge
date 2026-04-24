# Loomforge V1 Design Review (Updated)

**Reviewed:** `docs/loom-v1-design.md`
**Against:** `CLAUDE.md`, `docs/CONTEXT.md`, `docs/APPROACHES.md`
**Date:** 2026-04-08
**Reviewer:** OpenClaw (Claude Opus 4.6)
**Supersedes:** previous review of same date

---

## Verdict: APPROVE

The design is coherent, well-scoped, and faithful to the stated V1 constraints. Previous blockers (runner timeouts, recovery semantics) have been resolved in this revision. No new blockers found. The recommendations below would strengthen the design before implementation begins, but none block starting work on the build order.

---

## Prior blockers — now resolved

- **Runner timeouts (was B1):** The failure modes section now covers per-runner wall-clock timeouts, child process killing, partial log attachment, and `failureReason: timeout`. Resolved.
- **Recovery semantics (was B2):** The persistence model now specifies a two-phase transition model (record completion event, then advance state), restart behavior, and the assumption that child processes are dead after restart. Resolved.

## Prior recommendations — now addressed

- **Health endpoint (was R1):** `GET /health` is in the endpoint list. Resolved.
- **Verification/revision budget (was R3):** A single `revisionCount` is now specified, incremented on any return to `building`. Resolved.
- **Handoff schema timing (was R4):** Design now calls for `handoff.json` zod schema at step 2 alongside DB schema. Resolved.
- **run_attempts relationship (was R5):** Explicitly defined: one run = one top-level request, one run_attempt = one build -> verify -> review cycle. Resolved.
- **Scaffolding step (was R6):** Now explicit as step 0 in the build order. Resolved.
- **suggestedVerification removed (was N3):** No longer in `BuilderResult`. Resolved.
- **Single-run constraint stated (was N4):** "one active run at a time" is now explicit in the architecture section. Resolved.
- **YAML parser in stack (was N5):** `yaml` / `js-yaml` now listed. Resolved.

---

## Findings

### Blockers

None.

### Recommendations

**R1. Define the harness invocation contract explicitly.**
The design says Codex and Claude access must stay harness-only, but never specifies what "harness" means concretely. Is this the `codex` CLI? The `claude` CLI? A specific subprocess command shape? Without this, the runner adapter layer (build order steps 4 and 8) has no anchor.
- Suggestion: add a short "Runner harness contract" subsection under the builder and reviewer sections that names the exact binary/command, expected flags, working-directory behavior, and how stdin/stdout are consumed. Even a one-paragraph stub prevents ambiguity.

**R2. Add explicit `preparing_workspace -> blocked` transition.**
The failure modes section correctly says a dirty workspace should mark the run `blocked`, but the state machine diagram only shows `preparing_workspace -> building`. The `blocked` exit from `preparing_workspace` is implicit. Make it explicit in the state machine text block so the implementation matches.

**R3. Specify daemon lifecycle basics.**
The design says "one long-lived local daemon, `loomd`" but does not cover: how it starts (manual? launchd?), how it stops gracefully (SIGTERM handling?), what happens to an in-flight run on graceful shutdown, or how the CLI detects whether the daemon is running. A short "Daemon lifecycle" paragraph under High-level architecture would prevent ad-hoc decisions during step 0 scaffolding.

**R4. Clarify queue-drain trigger mechanism.**
The design says "Loom should own the ready queue and start the next queued run when idle." It is unclear whether the daemon polls the queue on a timer, reacts to a state-change event when a run completes, or requires an explicit API poke. Recommendation: event-driven drain (on run completion or new enqueue), with no internal timer, to stay consistent with the "no cron inside Loom" principle.

**R5. Version the `handoff.json` schema from day one.**
The design correctly flags `handoff.json` as a contract boundary and calls for a zod schema. Add a `version` field in the schema itself. OpenClaw and Loom will evolve at different speeds; an explicit version prevents silent contract drift.

**R6. Add wall-clock timeout defaults to project config.**
Runner timeouts are covered in failure modes but no default values or config shape are given. Even rough defaults (e.g., builder: 15 min, reviewer: 5 min, verification: 5 min) in the project config example would make the config section complete and prevent implementers from guessing independently.

**R7. Consider a `verifying -> blocked` path for environmental failures.**
Currently, verification failure within budget goes to `revising`, and exhaustion goes to `failed`. But some verification failures are environmental (missing toolchain, flaky CI infra) rather than code-related. A path from `verifying -> blocked` for non-code failures would let the operator intervene without burning revision budget.

### Notes

**N1. CLAUDE.md and the design doc are consistent.**
No meaningful mismatches found. CLAUDE.md correctly reflects the design's decisions on language, stack, architecture rules, non-goals, directory structure, and harness-only constraint. One minor additive difference: CLAUDE.md describes `src/app/` as "daemon bootstrap, lifecycle wiring, config loading, and service composition" while the design doc's directory tree shows `src/app/` without description. Not contradictory.

**N2. The `cancelled` state needs a source-state list.**
The state machine shows `cancelled` as a failure exit but does not say which states can transition to it. Presumably any non-terminal state can be cancelled via the API, but this should be stated.

**N3. `run_now_if_idle` rejection behavior is unspecified.**
The trigger contract says OpenClaw can send `run_now_if_idle`, but the design does not specify what happens if the system is not idle. Presumably Loom returns a structured error or auto-enqueues. Either is fine, but the choice should be documented.

**N4. The build order is sound and parallelizable.**
Steps 0-8 have correct dependency ordering. Steps 2 (SQLite schema + handoff zod) and 3 (worktree manager) are independent and could be parallelized if two builders are available.

**N5. CONTEXT.md has minor state-name drift.**
CONTEXT.md references states `passed` and `shipped` which do not appear in the design doc (which uses `ready_for_ship` and deliberately omits `shipped` since shipping is OpenClaw's concern). CONTEXT.md should be updated to match once the design is accepted.

**N6. CONTEXT.md references `src/linear/` directory; design doc does not.**
The design correctly folds Linear concerns into the OpenClaw trigger contract. The `src/linear/` reference in CONTEXT.md should be removed.

**N7. No test strategy section.**
The design covers build order and module structure but does not mention testing approach (unit tests for state machine, integration tests for runner adapters, etc.). Acceptable for a design doc, but should be addressed during step 0 scaffolding.

**N8. Risk of drifting into Paperclip-lite is well-controlled.**
The non-goals are explicit, CLAUDE.md reinforces them, and the design actively avoids hierarchy, autonomy, and platform abstractions. The main drift vector would be adding autonomous queue prioritization or multi-run parallelism. The current "FIFO, one active run" constraint is the correct guardrail.

---

## Open questions requiring human input

1. **Verification policy:** repo-config only, or allow issue-level overrides from OpenClaw? Design recommends repo-config only. I concur — issue-level overrides open a surface for prompt-injected commands.
2. **Runtime data location:** `~/.loom/` or under the workspace/projects tree? Design recommends `~/.loom/`. I concur — separates Loom state from any specific project tree.
3. **`run_now_if_idle` when busy:** return error, or silently enqueue? No recommendation in design. I recommend: return a structured rejection with current-run metadata, letting OpenClaw decide whether to enqueue explicitly.
4. **Daemon lifecycle for V1:** manual start, or launchd/systemd integration? I recommend: manual start for V1, with graceful SIGTERM handling documented.
