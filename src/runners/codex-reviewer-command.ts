import { REVIEW_RESULT_SCHEMA } from "./claude-reviewer-command.js";
import type { AgentTool } from "./codex-builder-runner.js";

export function reviewResultSchemaText(): string {
  return JSON.stringify(REVIEW_RESULT_SCHEMA, null, 2) + "\n";
}

export function codexReviewerCommand(
  schemaPath: string,
  lastMessagePath: string,
): { command: string; args: string[] } {
  return {
    command: "codex",
    args: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
    ],
  };
}

export function useStructuredCodexReviewer(tool: AgentTool): boolean {
  return tool === "codex" && process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT === "json-schema";
}
