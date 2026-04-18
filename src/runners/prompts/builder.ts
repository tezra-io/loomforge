import type { WorkflowStepContext } from "../../workflow/types.js";

export function buildPrompt(context: WorkflowStepContext): string {
  const { issue, workspace, revisionInput } = context;

  const sections: string[] = [
    `# Build Task: ${issue.identifier} — ${issue.title}`,
    "",
    "## Issue",
    issue.description ?? "(no description)",
    "",
  ];

  if (issue.acceptanceCriteria) {
    sections.push("## Acceptance Criteria", issue.acceptanceCriteria, "");
  }

  sections.push(
    "## Git Rules",
    `- Work on branch: ${workspace.branchName}`,
    "- Commit all changes with a clear message",
    "- Do NOT push. The orchestrator handles pushing.",
    "",
  );

  if (revisionInput) {
    sections.push(
      "## Revision Required",
      `Source: ${revisionInput.source}`,
      revisionInput.summary,
      "",
    );

    if (revisionInput.findings.length > 0) {
      sections.push("### Findings to Address");
      for (const finding of revisionInput.findings) {
        sections.push(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
      }
      sections.push("");
    }
  }

  if (issue.comments.length > 0) {
    sections.push("## Additional Context (Comments)");
    for (const comment of issue.comments) {
      sections.push(`- ${comment}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export function pushPrompt(branchName: string): string {
  return [
    "# Push Task",
    "",
    `Push the current branch "${branchName}" to the remote origin.`,
    `Run: git push origin ${branchName}`,
    "Do not force push. If the push fails, report the error.",
  ].join("\n");
}
