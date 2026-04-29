import type { AgentTool } from "./codex-builder-runner.js";

export const REVIEW_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "revise", "blocked"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2"],
          },
          title: { type: "string" },
          detail: { type: "string" },
          file: { type: "string" },
        },
        required: ["severity", "title", "detail"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["outcome", "findings", "summary"],
  additionalProperties: false,
} as const;

export function claudeReviewerCommand(schema = REVIEW_RESULT_SCHEMA): {
  command: string;
  args: string[];
} {
  return {
    command: "claude",
    args: [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
    ],
  };
}

export function useStructuredClaudeReviewer(tool: AgentTool): boolean {
  return tool === "claude" && process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT === "json-schema";
}
