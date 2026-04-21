import type { VerificationResult, WorkflowStepContext } from "../../workflow/types.js";

export function reviewPrompt(
  context: WorkflowStepContext,
  diff: string,
  verification?: VerificationResult | null,
): string {
  const { issue } = context;

  const sections: string[] = [
    `You are the Claude reviewer for ${issue.identifier}: ${issue.title}.`,
    "",
    "Review only. Do not edit, commit, or push.",
    "Finish the full review in one run. Do not pause to ask whether to continue.",
    "",
    "Before reviewing, read the repo's AGENTS.md or CLAUDE.md for conventions.",
    "Only flag issues in the diff — do not flag pre-existing code.",
    "",
    "Think like a staff engineer and a product manager. Review both the quality of",
    "the implementation and whether it actually delivers working functionality.",
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
    "## Review Focus",
    "",
    "- **Integration**: Wired in? Callers, routes, exports, config connected.",
    "- **Correctness**: Logic, off-by-one, null, concurrency.",
    "- **Regressions**: Breaks existing behavior?",
    "- **Edge cases**: Boundaries, error paths, empty/missing input.",
    "- **Tests**: Exercise real behavior, not just compilation. Integration covered.",
    "- **Completeness**: Feature works end-to-end without manual follow-up.",
    "- **Drift**: Matches the issue? Flag unrequested scope or silent behavior changes.",
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
    "## Classification",
    "",
    "- P0: must fix before shipping",
    "- P1: should fix now",
    "- P2: follow-up",
    "",
    "## Output Format",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no extra text):",
    "",
    "OUTCOME: pass | revise | blocked",
    "",
    '{"outcome":"pass","findings":[],"summary":"..."}',
    "or",
    '{"outcome":"revise","findings":[{"severity":"P0","title":"...","detail":"...","file":"..."}],"summary":"..."}',
    "",
    "If you cannot complete the review, respond with:",
    '{"outcome":"blocked","findings":[],"summary":"reason"}',
  );

  return sections.join("\n");
}
