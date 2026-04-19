import type { WorkflowStepContext } from "../../workflow/types.js";

export function buildPrompt(context: WorkflowStepContext): string {
  const { issue, project, workspace, revisionInput } = context;

  const sections: string[] = [
    `You are the Codex builder for ${issue.identifier}: ${issue.title}.`,
    "",
    `Repo: ${workspace.path}`,
    `Branch: ${workspace.branchName}`,
    "Do not push — the orchestrator handles pushing after review passes.",
    "",
    "## Issue",
    "",
    issue.description ?? "(no description)",
    "",
  ];

  if (issue.acceptanceCriteria) {
    sections.push("## Acceptance Criteria", "", issue.acceptanceCriteria, "");
  }

  if (issue.comments.length > 0) {
    sections.push("## Additional Context (Comments)");
    for (const comment of issue.comments) {
      sections.push(`- ${comment}`);
    }
    sections.push("");
  }

  if (revisionInput) {
    sections.push(
      "## Revision Required",
      "",
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

  sections.push(
    "## Approach",
    "",
    "Before writing any code, read the repo's AGENTS.md (or CLAUDE.md) and explore",
    "the codebase to understand the existing architecture, module boundaries, and",
    "how similar features are wired together.",
    "",
    "Deliver a complete, integrated feature — not just isolated code. Wire your",
    "implementation into the rest of the system: update callers, register routes,",
    "add exports, connect config, and update any entry points so the feature is",
    "actually reachable and functional without manual follow-up.",
    "",
    "Prefer tests first: write or update the failing test that proves the requested",
    "behavior, then implement until the tests pass. If tests-first is not practical,",
    "explain why in the final summary and still add appropriate coverage.",
    "",
  );

  sections.push(
    "## Git Rules",
    "",
    `- Stay on branch: ${workspace.branchName}`,
    `- Commit format: ${issue.identifier}: <short summary>`,
    "- Do NOT push. The orchestrator handles pushing.",
    "- If a pre-commit hook rejects, fix the code and retry.",
    "- Before committing, check `git status`. If you see generated or cached files",
    "  that should not be tracked, add them to .gitignore and commit that change.",
    "",
  );

  const gateLines = project.verification.commands.map((cmd) => cmd.command);
  sections.push("## Gate", "", "Run before finishing:", ...gateLines, "");

  sections.push(
    "## Output",
    "",
    "End with exactly one of:",
    "",
    "CHANGED_FILES:",
    "- <path>",
    "",
    "SUMMARY:",
    "<what you did>",
    "",
    "VERIFICATION:",
    "- <command>: <pass/fail and key output>",
    "- git status --short: <output>",
    "- git diff --name-only: <output>",
    "",
    "or:",
    "",
    "FAILED_NO_CHANGES: <exact blocker>",
  );

  return sections.join("\n");
}

export function pushPrompt(branchName: string, defaultBranch: string): string {
  return [
    "Push the current branch to the remote origin.",
    "",
    `Run: git push origin ${branchName}`,
    `NEVER push to ${defaultBranch}, main, or master. Only push to ${branchName}.`,
    "Do not force push. If the push fails, report the error.",
    "",
    "After pushing, report:",
    `COMMIT: <sha>`,
    "PUSH: <success or failure>",
  ].join("\n");
}
