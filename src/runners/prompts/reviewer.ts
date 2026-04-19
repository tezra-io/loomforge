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
    "- **Integration**: Is the new code wired into the rest of the system? Are",
    "  callers updated, routes registered, exports added, config connected? Code",
    "  that implements a feature in isolation but is never called is incomplete.",
    "- **Correctness**: Logic errors, off-by-one, null handling, concurrency.",
    "- **Regressions**: Does the change break existing behavior?",
    "- **Edge cases**: Boundary conditions, error paths, empty/missing input.",
    "- **Test quality**: Do tests exercise the actual behavior, not just prove",
    "  the code compiles? Are integration touchpoints covered?",
    "- **Completeness**: Would a user or caller of this feature get working",
    "  functionality without manual follow-up work?",
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
