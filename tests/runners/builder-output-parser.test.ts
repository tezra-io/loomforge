import { describe, expect, it } from "vitest";

import {
  BUILDER_OUTPUT_SCHEMA,
  builderOutputSchemaHash,
  builderOutputSchemaText,
  extractCodexFinalAssistantText,
  parseBuilderOutputText,
} from "../../src/runners/builder-output-parser.js";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "success",
    changed_files: ["src/index.ts"],
    summary: "Implemented the change",
    verification: [{ command: "pnpm test", outcome: "pass", summary: "passed" }],
    blocker: "",
    ...overrides,
  };
}

describe("builder output parser", () => {
  it("exports a strict Codex-compatible schema", () => {
    expect(BUILDER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(BUILDER_OUTPUT_SCHEMA.required).toEqual([
      "outcome",
      "changed_files",
      "summary",
      "verification",
      "blocker",
    ]);
    expect(builderOutputSchemaText()).toContain('"failed_no_changes"');
    expect(builderOutputSchemaHash()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses a bare schema-shaped JSON payload", () => {
    const result = parseBuilderOutputText(JSON.stringify(payload()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.outcome).toBe("success");
    expect(result.payload.changed_files).toEqual(["src/index.ts"]);
  });

  it("extracts fenced JSON from final assistant text", () => {
    const result = parseBuilderOutputText(
      ["Done:", "```json", JSON.stringify(payload()), "```"].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.summary).toBe("Implemented the change");
  });

  it("extracts surrounded JSON from final assistant text", () => {
    const result = parseBuilderOutputText(
      `Here is the result ${JSON.stringify(payload({ changed_files: ["actual.ts"] }))} complete.`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.changed_files).toEqual(["actual.ts"]);
  });

  it("rejects invalid schema-shaped candidates", () => {
    const result = parseBuilderOutputText('{"outcome":"success","summary":"missing fields"}');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_shape");
  });

  it("extracts the final assistant text from observed Codex JSONL events", () => {
    const events = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: JSON.stringify(payload()) },
      }),
      '{"type":"turn.completed"}',
    ].join("\n");

    expect(extractCodexFinalAssistantText(events)).toBe(JSON.stringify(payload()));
  });
});
