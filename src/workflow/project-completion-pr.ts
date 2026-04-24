export interface ShippedIssue {
  id: string;
  title: string | null;
}

export interface MergePrContent {
  title: string;
  body: string;
}

export function buildMergePr(
  projectSlug: string,
  defaultBranch: string,
  shipped: ReadonlyArray<ShippedIssue>,
): MergePrContent {
  const count = shipped.length;
  const word = count === 1 ? "issue" : "issues";
  const title = `[${projectSlug}] Ship ${count} ${word} to ${defaultBranch}`;

  const lines = [
    `Ships ${count} ${word} from \`dev\` into \`${defaultBranch}\`.`,
    "",
    ...shipped.map(renderShippedLine),
  ];
  return { title, body: lines.join("\n") };
}

function renderShippedLine(issue: ShippedIssue): string {
  const title = issue.title?.trim();
  if (!title) return `- **${issue.id}**`;
  return `- **${issue.id}** — ${title}`;
}
