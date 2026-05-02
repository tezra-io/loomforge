import { describe, expect, it } from "vitest";

import { sanitizePrReview } from "../../src/runners/pr-review-sanitizer.js";
import type { PrReviewResult, ProjectCompletionIssue } from "../../src/workflow/types.js";

const acceptanceText =
  "When a user submits the form with an invalid email the API must return 422 with a typed error object containing field and message.";

const issues: ProjectCompletionIssue[] = [
  {
    id: "TEZ-1",
    title: "Form validation",
    description: "Existing flow must reject malformed payloads before persistence runs.",
    acceptanceCriteria: acceptanceText,
    runId: "run-1",
    commitShas: ["sha-1"],
  },
];

function reviewWith(
  findings: PrReviewResult["findings"],
  summary = "Summary",
  outcome: PrReviewResult["outcome"] = "findings",
): PrReviewResult {
  return { outcome, findings, summary, rawLogPath: "/log" };
}

describe("sanitizePrReview", () => {
  it("drops findings whose detail copies issue acceptance criteria text", () => {
    const review = reviewWith([
      {
        severity: "P1",
        title: "validation gap",
        detail: `The handler must enforce: ${acceptanceText}`,
        file: "src/api.ts",
        startLine: 12,
      },
      {
        severity: "P2",
        title: "naming",
        detail: "Use camelCase for the new helper functions in the validator module.",
        file: "src/api.ts",
        startLine: 30,
      },
    ]);

    const { result, report } = sanitizePrReview(review, issues);

    expect(report.removedFindings).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("naming");
  });

  it("redacts the summary if it leaks issue text", () => {
    const review = reviewWith(
      [
        {
          severity: "P2",
          title: "small nit",
          detail:
            "Rename helper to validatePayload for consistency with the file naming convention.",
          file: "src/api.ts",
          startLine: 5,
        },
      ],
      `Reviewer notes: ${acceptanceText}`,
    );

    const { result, report } = sanitizePrReview(review, issues);

    expect(report.summaryRedacted).toBe(true);
    expect(result.summary).toMatch(/suppressed/i);
    expect(result.findings).toHaveLength(1);
  });

  it("downgrades to 'pass' when every finding is dropped", () => {
    const review = reviewWith([
      {
        severity: "P1",
        title: "leak 1",
        detail: acceptanceText,
        file: "src/api.ts",
        startLine: 1,
      },
      {
        severity: "P1",
        title: "leak 2",
        detail: acceptanceText,
        file: "src/api.ts",
        startLine: 2,
      },
    ]);

    const { result, report } = sanitizePrReview(review, issues);

    expect(report.removedFindings).toBe(2);
    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("passes through clean reviews unchanged", () => {
    const review = reviewWith([
      {
        severity: "P2",
        title: "naming",
        detail: "Rename the helper for clarity.",
        file: "src/api.ts",
        startLine: 5,
      },
    ]);

    const { result, report } = sanitizePrReview(review, issues);

    expect(report.removedFindings).toBe(0);
    expect(report.summaryRedacted).toBe(false);
    expect(result).toEqual(review);
  });

  it("does nothing when issues have no description or acceptance text", () => {
    const review = reviewWith([
      {
        severity: "P1",
        title: "x",
        detail: "y",
        file: "src/a.ts",
        startLine: 1,
      },
    ]);
    const { result, report } = sanitizePrReview(review, [
      {
        id: "TEZ-99",
        title: "no body",
        description: null,
        acceptanceCriteria: null,
        runId: "run-99",
        commitShas: [],
      },
    ]);
    expect(report.removedFindings).toBe(0);
    expect(result.findings).toHaveLength(1);
  });
});
