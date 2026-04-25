import { describe, expect, it } from "vitest";

import { parseReviewerOutput } from "../../src/runners/review-output-parser.js";

describe("parseReviewerOutput", () => {
  it("parses a bare JSON payload", () => {
    const stdout = JSON.stringify({
      outcome: "pass",
      findings: [],
      summary: "Looks good",
    });

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("pass");
    expect(result.payload.summary).toBe("Looks good");
  });

  it("parses a fenced JSON block when prose wraps it", () => {
    const stdout = [
      "Here is my review:",
      "```json",
      JSON.stringify({ outcome: "pass", findings: [], summary: "OK" }),
      "```",
      "Thanks!",
    ].join("\n");

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("pass");
  });

  it("ignores prose braces and returns the real JSON payload", () => {
    const stdout = [
      "Looking at the diff, I see problems with `{variable}` references",
      "and template placeholders like {field}.",
      "",
      JSON.stringify({
        outcome: "revise",
        findings: [{ severity: "P0", title: "Missing check", detail: "Needs null guard" }],
        summary: "Needs fixes",
      }),
    ].join("\n");

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("revise");
    expect(result.payload.findings).toHaveLength(1);
    expect(result.payload.findings.at(0)?.title).toBe("Missing check");
  });

  it("skips earlier candidates that are not valid review outputs", () => {
    const stdout = [
      'Example of an arbitrary object: {"hint": "not a review"}',
      "",
      "My actual review:",
      JSON.stringify({
        outcome: "pass",
        findings: [],
        summary: "All good",
      }),
    ].join("\n");

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("pass");
  });

  it("returns no_json when the output has no JSON blocks", () => {
    const result = parseReviewerOutput("I could not review this code");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_json");
  });

  it("returns invalid_shape when candidates exist but none match the review shape", () => {
    const result = parseReviewerOutput('{"hello": "world"}');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_shape");
  });

  it("filters out malformed findings but keeps valid ones", () => {
    const stdout = JSON.stringify({
      outcome: "revise",
      findings: [
        { severity: "P0", title: "Valid", detail: "real finding" },
        { severity: "INVALID", title: "Bad severity" },
        { not_a_finding: true },
      ],
      summary: "Mixed findings",
    });

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.findings).toHaveLength(1);
    expect(result.payload.findings.at(0)?.severity).toBe("P0");
  });

  it("recovers a payload truncated before the outer closing brace", () => {
    const full = JSON.stringify({
      outcome: "revise",
      findings: [{ severity: "P1", title: "T", detail: "D" }],
      summary: "Address the crash before merging.",
    });
    const truncated = full.slice(0, -1);

    const result = parseReviewerOutput(truncated);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("revise");
    expect(result.payload.findings).toHaveLength(1);
  });

  it("recovers a payload truncated after the summary string", () => {
    const truncated = '{"outcome":"pass","findings":[],"summary":"All good"';

    const result = parseReviewerOutput(truncated);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("pass");
    expect(result.payload.summary).toBe("All good");
  });

  it("recovers a payload with a trailing comma after the last field", () => {
    const truncated = '{"outcome":"pass","findings":[],"summary":"OK",';

    const result = parseReviewerOutput(truncated);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("pass");
  });

  it("does not recover when truncation lands inside a string", () => {
    const truncated = '{"outcome":"revise","findings":[],"summary":"unfinished';

    const result = parseReviewerOutput(truncated);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_json");
  });

  it("tolerates strings containing braces inside the JSON payload", () => {
    const stdout = JSON.stringify({
      outcome: "revise",
      findings: [
        {
          severity: "P1",
          title: "Template literal issue",
          detail: "Use `${value}` not {value}",
        },
      ],
      summary: "Fix `{foo}` interpolation",
    });

    const result = parseReviewerOutput(stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.findings.at(0)?.title).toBe("Template literal issue");
  });
});
