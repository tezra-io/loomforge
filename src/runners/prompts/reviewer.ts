import type { WorkflowStepContext } from "../../workflow/types.js";

export function reviewPrompt(context: WorkflowStepContext, diff: string): string {
  const { issue } = context;

  const sections: string[] = [
    `# Code Review: ${issue.identifier} — ${issue.title}`,
    "",
    "## Issue Description",
    issue.description ?? "(no description)",
    "",
  ];

  if (issue.acceptanceCriteria) {
    sections.push("## Acceptance Criteria", issue.acceptanceCriteria, "");
  }

  sections.push(
    "## Review Rules",
    "- This is a READ-ONLY review. Do NOT edit any files.",
    "- Categorize each finding as P0 (blocking), P1 (should fix), or P2 (nice to have).",
    "- Focus on: correctness, edge cases, regressions, test quality, security.",
    "- Verify the implementation satisfies the issue requirements.",
    "",
    "## Diff to Review",
    "```",
    diff,
    "```",
    "",
    "## Output Format",
    "Respond with ONLY a JSON object (no markdown fences, no extra text):",
    '{"outcome":"pass","findings":[],"summary":"..."}',
    "or",
    '{"outcome":"revise","findings":[{"severity":"P0","title":"...","detail":"...","file":"..."}],"summary":"..."}',
    "",
    "If you cannot complete the review, respond with:",
    '{"outcome":"blocked","findings":[],"summary":"reason"}',
  );

  return sections.join("\n");
}
