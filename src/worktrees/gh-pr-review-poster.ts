import { execa } from "execa";

import type {
  GhPrReviewPoster as GhPrReviewPosterContract,
  PrReviewFinding,
  PrReviewPostResult,
  PrReviewResult,
  PullRequestSnapshot,
} from "../workflow/types.js";

export interface PostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PostCommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; stdin?: string },
) => Promise<PostCommandResult>;

export interface GhPrReviewPosterOptions {
  runner?: PostCommandRunner;
}

interface ReviewPayload {
  event: "COMMENT";
  body: string;
  comments: InlineComment[];
}

interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

const defaultRunner: PostCommandRunner = async (cmd, args, opts) => {
  const result = await execa(cmd, args, {
    cwd: opts.cwd,
    input: opts.stdin,
    reject: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export class GhPrReviewPoster implements GhPrReviewPosterContract {
  private readonly runner: PostCommandRunner;

  constructor(options: GhPrReviewPosterOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
  }

  async post(
    pullRequest: PullRequestSnapshot,
    review: PrReviewResult,
  ): Promise<PrReviewPostResult> {
    const target = parseOwnerRepo(pullRequest.url);
    if (!target) {
      return {
        outcome: "post_failed",
        summary: `Could not parse owner/repo from PR URL: ${pullRequest.url}`,
      };
    }

    const payload = buildReviewPayload(review);
    const result = await this.runner(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${target.owner}/${target.repo}/pulls/${pullRequest.number}/reviews`,
        "--input",
        "-",
      ],
      { stdin: JSON.stringify(payload) },
    );

    if (result.exitCode !== 0) {
      return {
        outcome: "post_failed",
        summary: result.stderr.trim() || `gh api exited with code ${result.exitCode}`,
      };
    }

    const reviewUrl = parseReviewUrl(result.stdout);
    if (!reviewUrl) {
      return {
        outcome: "post_failed",
        summary: "gh api response did not include html_url",
      };
    }
    return { outcome: "posted", reviewUrl };
  }
}

function parseOwnerRepo(url: string): OwnerRepo | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!match) return null;
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

function parseReviewUrl(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const html = (parsed as Record<string, unknown>)["html_url"];
  return typeof html === "string" ? html : null;
}

function buildReviewPayload(review: PrReviewResult): ReviewPayload {
  const inline: InlineComment[] = [];
  const overflow: PrReviewFinding[] = [];
  for (const finding of review.findings) {
    const comment = toInlineComment(finding);
    if (comment) {
      inline.push(comment);
    } else {
      overflow.push(finding);
    }
  }
  return {
    event: "COMMENT",
    body: renderBody(review.summary, overflow),
    comments: inline,
  };
}

function toInlineComment(finding: PrReviewFinding): InlineComment | null {
  if (!finding.file || finding.startLine === undefined) return null;
  const startLine = finding.startLine;
  const endLine = finding.endLine ?? startLine;
  const body = `**${finding.severity} — ${finding.title}**\n\n${finding.detail}`;
  if (endLine > startLine) {
    return {
      path: finding.file,
      start_line: startLine,
      start_side: "RIGHT",
      line: endLine,
      side: "RIGHT",
      body,
    };
  }
  return { path: finding.file, line: startLine, side: "RIGHT", body };
}

function renderBody(summary: string, overflow: PrReviewFinding[]): string {
  const parts: string[] = [summary.trim() || "_No summary._"];
  if (overflow.length > 0) {
    parts.push("", "### Findings without line anchors", "");
    for (const finding of overflow) {
      parts.push(`- **${finding.severity} — ${finding.title}**: ${finding.detail}`);
    }
  }
  return parts.join("\n");
}
