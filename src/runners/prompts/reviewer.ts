import type { VerificationResult, WorkflowStepContext } from "../../workflow/types.js";

export function reviewPrompt(
  context: WorkflowStepContext,
  diff: string,
  verification?: VerificationResult | null,
): string {
  const { issue } = context;

  const sections: string[] = [
    `You are the Claude reviewer for ${issue.identifier}: ${issue.title}.`,
    "Think like a staff engineer and a product manager — review both implementation",
    "quality and whether it actually delivers working functionality.",
    "",
    "Review only. Do not edit, commit, or push. Finish in one run.",
    "Read the repo's AGENTS.md or CLAUDE.md for conventions before reviewing.",
    "",
    "## When to flag",
    "",
    "Flag only if all hold: introduced by this diff (not pre-existing); meaningfully",
    "affects correctness, security, performance, or maintainability; discrete and",
    "actionable with file + lines cited; not speculative — name the affected code",
    "or input; the author would fix if shown. Zero findings IS the right answer",
    "when the diff is clean; do not invent issues.",
    "",
    "## Issue Description",
    "",
    issue.description ?? "(no description)",
    "",
  ];

  if (issue.acceptanceCriteria) {
    sections.push("## Acceptance Criteria", "", issue.acceptanceCriteria, "");
  }

  sections.push(
    "## Review focus",
    "",
    "- **Integration**: wired in — callers, routes, exports, config connected.",
    "- **Correctness**: logic, off-by-one, null, concurrency.",
    "- **Regressions**: breaks existing behavior?",
    "- **Edge cases**: boundaries, error paths, empty/missing input.",
    "- **Tests**: exercise real behavior, not just compilation. Integration covered.",
    "- **Completeness**: feature works end-to-end without manual follow-up.",
    "- **Drift**: matches the issue. Flag unrequested scope or silent behavior changes.",
    "- **Security**: SQLi, XSS, CMDi, hardcoded secrets, missing auth, broad perms.",
    "",
  );

  if (verification && verification.commandResults.length > 0) {
    sections.push("## Verification Results", "");
    for (const cmd of verification.commandResults) {
      sections.push(`- ${cmd.name}: ${cmd.outcome}`);
    }
    sections.push("");
  }

  sections.push("## Diff to Review", "", "```", diff, "```", "");

  sections.push(
    "## Severity",
    "",
    "- P0: ships broken under realistic input — block.",
    "- P1: wrong under common input, or breaks existing behavior — fix before merge.",
    "- P2: follow-up. Does not block this run.",
    "",
    "## Finding quality",
    "",
    "Brief, matter-of-fact, one short paragraph each. Cite file and lines. Name the",
    "input or scenario the bug needs. No flattery, no hedging, no general codebase",
    "commentary.",
    "",
    "## Output",
    "",
    "Respond with ONLY a JSON object (no fences, no extra text):",
    '{"outcome":"pass","findings":[],"summary":"..."}',
    '{"outcome":"revise","findings":[{"severity":"P0","title":"...","detail":"...","file":"..."}],"summary":"..."}',
    '{"outcome":"blocked","findings":[],"summary":"reason"}',
  );

  return sections.join("\n");
}
