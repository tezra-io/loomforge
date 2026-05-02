import { describe, expect, it } from "vitest";

import type { ProjectCompletionIssue, PullRequestSnapshot } from "../../src/workflow/types.js";
import { prReviewPrompt } from "../../src/runners/prompts/pr-reviewer.js";

const samplePr: PullRequestSnapshot = {
  url: "https://github.com/org/loom/pull/42",
  number: 42,
  baseBranch: "main",
  devBranch: "dev",
  baseSha: "base-sha",
  devSha: "dev-sha",
  body: "PR body",
};

const sampleIssues: ProjectCompletionIssue[] = [
  {
    id: "TEZ-1",
    title: "Wire X to Y",
    description: "We need X to call Y under condition Z.",
    acceptanceCriteria: "- A\n- B",
    runId: "run-1",
    commitShas: ["sha-1"],
  },
];

describe("prReviewPrompt", () => {
  it("frames the role as a non-blocking second pair of eyes", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/second pair of eyes/i);
    expect(prompt).toMatch(/will not block any automation/i);
  });

  it("tells the reviewer that each issue already passed per-issue review", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/already passed an independent per-issue review/i);
    expect(prompt).toMatch(/skip in-issue concerns/i);
  });

  it("reframes severity as comment loudness, not a gate", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/urgency for the human reader/i);
    expect(prompt).not.toMatch(/auto-?revis/i);
    expect(prompt).not.toMatch(/will block merge/i);
  });

  it("includes the public-comment hygiene rule", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/posted to a public GitHub PR review/i);
    expect(prompt).toMatch(/Reference code only/i);
    expect(prompt).toMatch(/Do not quote, paraphrase, or reference Linear/i);
  });

  it("requires line anchors when possible", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/startLine/);
    expect(prompt).toMatch(/endLine/);
  });

  it("preserves the 'zero findings is the right answer' clause", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/Zero findings IS the right answer/i);
    expect(prompt).toMatch(/do not invent issues/i);
  });

  it("includes PR metadata, branches, the diff, and shipped issue context", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff --git a/x b/x\n+changed",
    });

    expect(prompt).toContain("https://github.com/org/loom/pull/42");
    expect(prompt).toContain("main");
    expect(prompt).toContain("dev");
    expect(prompt).toContain("TEZ-1");
    expect(prompt).toContain("Wire X to Y");
    expect(prompt).toContain("We need X to call Y");
    expect(prompt).toContain("- A\n- B");
    expect(prompt).toContain("+changed");
  });

  it("emits the pass | findings | blocked output contract examples", () => {
    const prompt = prReviewPrompt({
      pullRequest: samplePr,
      shippedIssues: sampleIssues,
      diff: "diff text",
    });

    expect(prompt).toMatch(/"outcome":"pass"/);
    expect(prompt).toMatch(/"outcome":"findings"/);
    expect(prompt).toMatch(/"outcome":"blocked"/);
    expect(prompt).not.toMatch(/"outcome":"revise"/);
  });
});
