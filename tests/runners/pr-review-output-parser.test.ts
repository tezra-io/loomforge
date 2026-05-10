import { describe, expect, it } from "vitest";

import { parsePrReviewerOutput } from "../../src/runners/pr-review-output-parser.js";

describe("parsePrReviewerOutput", () => {
  it("parses a 'pass' outcome with no findings", () => {
    const result = parsePrReviewerOutput(
      JSON.stringify({
        outcome: "pass",
        findings: [],
        summary: "No cross-issue concerns.",
      }),
    );

    expect(result).toEqual({
      ok: true,
      payload: {
        outcome: "pass",
        findings: [],
        summary: "No cross-issue concerns.",
      },
    });
  });

  it("parses a 'findings' outcome with line-anchored findings", () => {
    const result = parsePrReviewerOutput(
      JSON.stringify({
        outcome: "findings",
        findings: [
          {
            severity: "P1",
            title: "missing wiring",
            detail: "src/x.ts does not import src/y.ts",
            file: "src/x.ts",
            startLine: 10,
            endLine: 12,
          },
          {
            severity: "P2",
            title: "naming inconsistency",
            detail: "use camelCase for new helper",
            file: "src/y.ts",
            startLine: 4,
          },
        ],
        summary: "1 P1, 1 P2",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.outcome).toBe("findings");
      expect(result.payload.findings).toHaveLength(2);
      expect(result.payload.findings[0]).toEqual({
        severity: "P1",
        title: "missing wiring",
        detail: "src/x.ts does not import src/y.ts",
        file: "src/x.ts",
        startLine: 10,
        endLine: 12,
      });
      expect(result.payload.findings[1]?.endLine).toBeUndefined();
    }
  });

  it("parses a 'blocked' outcome with empty findings", () => {
    const result = parsePrReviewerOutput(
      JSON.stringify({
        outcome: "blocked",
        findings: [],
        summary: "Diff too large",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      payload: { outcome: "blocked", summary: "Diff too large" },
    });
  });

  it("rejects malformed JSON with reason 'no_json'", () => {
    const result = parsePrReviewerOutput("not even json");
    expect(result).toEqual({ ok: false, reason: "no_json" });
  });

  it("rejects valid JSON with the wrong shape", () => {
    const result = parsePrReviewerOutput(
      JSON.stringify({ outcome: "revise", findings: [], summary: "x" }),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_shape" });
  });

  it("filters invalid finding entries while keeping valid ones", () => {
    const result = parsePrReviewerOutput(
      JSON.stringify({
        outcome: "findings",
        findings: [
          { severity: "P1", title: "good", detail: "ok", file: "src/a.ts", startLine: 1 },
          { severity: "BAD", title: "x", detail: "y" },
          { title: "no severity", detail: "y" },
        ],
        summary: "mixed",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.findings).toHaveLength(1);
      expect(result.payload.findings[0]?.title).toBe("good");
    }
  });

  it("unwraps Claude's structured_output wrapper", () => {
    const wrapper = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: {
        outcome: "pass",
        findings: [],
        summary: "No cross-issue concerns.",
      },
    };
    const result = parsePrReviewerOutput(JSON.stringify(wrapper));
    expect(result).toEqual({
      ok: true,
      payload: {
        outcome: "pass",
        findings: [],
        summary: "No cross-issue concerns.",
      },
    });
  });

  it("unwraps a Claude wrapper containing findings with line anchors", () => {
    const wrapper = {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: {
        outcome: "findings",
        findings: [
          {
            severity: "P1",
            title: "wiring",
            detail: "x",
            file: "src/x.ts",
            startLine: 10,
            endLine: 12,
          },
        ],
        summary: "1 P1",
      },
    };
    const result = parsePrReviewerOutput(JSON.stringify(wrapper));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.findings).toHaveLength(1);
      expect(result.payload.findings[0]?.startLine).toBe(10);
    }
  });

  it("rejects output that is not pure JSON (chatter around the payload)", () => {
    const result = parsePrReviewerOutput(
      `Here's my review:\n\n${JSON.stringify({
        outcome: "pass",
        findings: [],
        summary: "all good",
      })}\nThanks.`,
    );

    expect(result).toEqual({ ok: false, reason: "no_json" });
  });
});
