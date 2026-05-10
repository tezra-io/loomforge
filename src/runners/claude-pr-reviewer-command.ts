export const PR_REVIEW_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "findings", "blocked"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          title: { type: "string" },
          detail: { type: "string" },
          file: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
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

export function claudePrReviewerCommand(schema: object = PR_REVIEW_RESULT_SCHEMA): {
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
