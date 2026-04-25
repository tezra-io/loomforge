import type { ReviewFinding } from "../../workflow/types.js";

export interface DesignBuilderPromptContext {
  slug: string;
  feature: string | null;
  kind: "new" | "extend";
  repoPath: string;
  designDocPath: string;
  designTemplatePath: string;
  requirementMarkdown: string;
  revisionFindings?: ReviewFinding[];
  revisionSummary?: string;
}

export function designBuilderPrompt(ctx: DesignBuilderPromptContext): string {
  const title = ctx.feature ? `${ctx.slug}-${ctx.feature}` : ctx.slug;

  const sections: string[] = [
    `You are the Codex design-builder for project "${ctx.slug}"${ctx.feature ? ` (feature: ${ctx.feature})` : ""}.`,
    "",
    `Repo root: ${ctx.repoPath}`,
    `Write the design doc to: ${ctx.designDocPath}`,
    "Create parent directories as needed.",
    "",
    "## Task",
    "",
    `Draft a ${ctx.kind === "new" ? "new-project" : "feature-extension"} design document titled "${title}".`,
    "Perform any research required yourself — do not ask the operator.",
    "",
    "## Requirement",
    "",
    ctx.requirementMarkdown,
    "",
    "## Template",
    "",
    `The required section structure lives at: ${ctx.designTemplatePath}`,
    "Read that file first. It defines section headers and per-section instructions.",
    "",
    "## Template Rules (strict)",
    "",
    "- Keep the section headers from the template. Same order, same names.",
    "- REPLACE the instructional prose in each section with the real content it describes.",
    "- Do NOT copy the instructional prose through. Do NOT quote it.",
    "- REPLACE every `{placeholder}` and `<!-- HTML comment -->` with concrete content.",
    "- Remove any 'Copy into new projects. Fill in placeholders.' style header lines.",
    "- The finished file must be valid markdown with no leftover meta-instructions.",
    "- If a section legitimately does not apply, remove it with a brief note in the summary.",
    "",
  ];

  if (ctx.revisionFindings && ctx.revisionFindings.length > 0) {
    sections.push(
      "## Revision Required",
      "",
      ctx.revisionSummary ?? "",
      "",
      "### Findings to Address",
    );
    for (const finding of ctx.revisionFindings) {
      sections.push(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
    }
    sections.push(
      "",
      "Apply every finding above. Preserve unrelated content. Save to the same path.",
      "",
    );
  }

  sections.push(
    "## Output Contract",
    "",
    "After writing the file, end your response with exactly two marker lines:",
    "",
    `DESIGN_DOC_PATH: ${ctx.designDocPath}`,
    "SUMMARY: <one or two sentences on what you produced>",
    "",
    "Do not include fenced code blocks around these markers. They must appear on",
    "their own lines at the end of stdout.",
  );

  return sections.join("\n");
}
