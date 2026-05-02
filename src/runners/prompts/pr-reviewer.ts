import type { ProjectCompletionIssue, PullRequestSnapshot } from "../../workflow/types.js";

export interface PrReviewPromptInput {
  pullRequest: PullRequestSnapshot;
  shippedIssues: ProjectCompletionIssue[];
  diff: string;
}

export function prReviewPrompt(input: PrReviewPromptInput): string {
  const { pullRequest, shippedIssues, diff } = input;

  const sections: string[] = [
    "You are a second pair of eyes for the human reviewer about to merge this PR.",
    "Your findings will be posted as a GitHub PR review and will not block any automation.",
    "Flag what a human reviewer would want surfaced before they merge.",
    "",
    "Read the repo's AGENTS.md or CLAUDE.md for conventions before reviewing.",
    "",
    "## Scope",
    "",
    "Each shipped issue has already passed an independent per-issue review covering",
    "in-issue correctness, single-function bugs, and single-issue tests.",
    "Skip in-issue concerns unless the bug only becomes visible when issues are combined.",
    "",
    "Focus the review on cross-cutting concerns:",
    "- Integration between issues — wiring, shared types/contracts, route/export reachability across issue boundaries.",
    "- Missing wiring — one issue exposes something another was supposed to consume but didn't.",
    "- Cross-issue regressions — one issue silently broke behavior another issue or pre-existing code relies on.",
    "- Contract drift — issues solving overlapping problems with inconsistent interfaces, error shapes, or naming.",
    "- Product-level coherence — does the merged set deliver the project's outcome end-to-end without manual follow-up?",
    "- Integration-seam security — auth/authz, input boundaries, secret handling that only matter at the seams.",
    "- Cross-issue test gaps — flows that span issues with no integration test.",
    "",
    "## Severity",
    "",
    "Severity labels signal urgency for the human reader, not gating behavior:",
    "- P0: do not merge until addressed.",
    "- P1: should fix before merge.",
    "- P2: follow-up worth tracking.",
    "",
    "## Public-comment hygiene",
    "",
    "Your `title`, `detail`, and `summary` will be posted to a public GitHub PR review.",
    "Reference code only — file paths, function names, line numbers, observed behavior.",
    "Do not quote, paraphrase, or reference Linear issue descriptions, acceptance criteria,",
    "or comments. Issue context is for your reasoning, not for the comment readers.",
    "",
    "## Line anchors",
    "",
    "For every finding tied to specific code, provide `file`, `startLine`, and (when the",
    "concern spans more than one line) `endLine`. Findings without resolvable line anchors",
    "are allowed but should be the exception — they render in the summary body.",
    "",
    "## Finding quality",
    "",
    "Brief, matter-of-fact, one short paragraph each. Cite file and lines. Name the",
    "input or scenario the bug needs. No flattery, no hedging, no general codebase commentary.",
    "Zero findings IS the right answer when the change set is clean — do not invent issues.",
    "",
    "## Pull request",
    "",
    `URL: ${pullRequest.url}`,
    `Base branch: ${pullRequest.baseBranch} (sha ${pullRequest.baseSha})`,
    `Dev branch: ${pullRequest.devBranch} (sha ${pullRequest.devSha})`,
    "",
    "## Shipped issues",
    "",
    ...shippedIssues.flatMap(renderIssue),
    "## Diff to review",
    "",
    "```",
    diff,
    "```",
    "",
    "## Output",
    "",
    "Respond with ONLY a JSON object (no fences, no extra text) matching one of:",
    '{"outcome":"pass","findings":[],"summary":"No cross-issue concerns. Per-issue reviews already covered in-issue correctness."}',
    '{"outcome":"findings","findings":[{"severity":"P1","title":"...","detail":"...","file":"src/x.ts","startLine":42,"endLine":47}],"summary":"..."}',
    '{"outcome":"blocked","findings":[],"summary":"Diff exceeds context window; provide compare URL only."}',
  ];

  return sections.join("\n");
}

function renderIssue(issue: ProjectCompletionIssue): string[] {
  const lines: string[] = [`### ${issue.id} — ${issue.title ?? "(no title)"}`, ""];
  if (issue.description) {
    lines.push("Description:", issue.description, "");
  }
  if (issue.acceptanceCriteria) {
    lines.push("Acceptance criteria:", issue.acceptanceCriteria, "");
  }
  return lines;
}
