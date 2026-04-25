import { join } from "node:path";

import type { ReviewFinding } from "../workflow/types.js";
import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { isRunnerAuthError, runProcess } from "./process-runner.js";
import {
  designReviewerPrompt,
  type DesignReviewerPromptContext,
} from "./prompts/design-reviewer.js";
import { parseReviewerOutput } from "./review-output-parser.js";

export type DesignReviewOutcome = "pass" | "revise" | "blocked";

export interface DesignReviewSuccess {
  outcome: DesignReviewOutcome;
  findings: ReviewFinding[];
  summary: string;
  rawLogPath: string;
}

export interface DesignReviewerRunOptions {
  runId: string;
  attemptLabel: string;
  cwd: string;
  tool: AgentTool;
  timeoutMs: number;
  artifactDir: string;
  prompt: DesignReviewerPromptContext;
}

export class DesignReviewerRunner {
  async run(options: DesignReviewerRunOptions): Promise<DesignReviewSuccess> {
    const logDir = join(options.artifactDir, options.runId);
    const prompt = designReviewerPrompt(options.prompt);
    const { command, args } = agentCommand(options.tool);

    const result = await runProcess({
      command,
      args,
      cwd: options.cwd,
      stdin: prompt,
      timeoutMs: options.timeoutMs,
      artifactDir: logDir,
      label: options.attemptLabel,
    });

    if (result.timedOut) {
      return {
        outcome: "blocked",
        findings: [],
        summary: `Design reviewer timed out after ${options.timeoutMs}ms`,
        rawLogPath: result.stderrLogPath,
      };
    }

    if (result.exitCode !== 0) {
      if (isRunnerAuthError(result.stderr)) {
        return {
          outcome: "blocked",
          findings: [],
          summary: `Design reviewer auth failed: ${truncate(result.stderr, 500)}`,
          rawLogPath: result.stderrLogPath,
        };
      }
      return {
        outcome: "blocked",
        findings: [],
        summary: `Design reviewer exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
      };
    }

    return parseDesignReviewerOutput(result.stdout, result.stdoutLogPath);
  }
}

export function parseDesignReviewerOutput(stdout: string, rawLogPath: string): DesignReviewSuccess {
  const parsed = parseReviewerOutput(stdout);
  if (parsed.ok) {
    return {
      outcome: parsed.payload.outcome,
      findings: parsed.payload.findings,
      summary: parsed.payload.summary,
      rawLogPath,
    };
  }

  const summary =
    parsed.reason === "no_json"
      ? "Reviewer output did not contain valid JSON"
      : "Reviewer output JSON has unexpected shape";
  return {
    outcome: "blocked",
    findings: [],
    summary,
    rawLogPath,
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
