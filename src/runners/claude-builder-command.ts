import { BUILDER_OUTPUT_SCHEMA } from "./builder-output-parser.js";
import type { AgentTool } from "./codex-builder-runner.js";

export function claudeBuilderCommand(schema: object = BUILDER_OUTPUT_SCHEMA): {
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

export function useStructuredClaudeBuilder(tool: AgentTool): boolean {
  return tool === "claude" && process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT === "json-schema";
}
