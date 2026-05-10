import type {
  ProjectReviewContext,
  ProjectReviewerRunner,
  PrReviewResult,
} from "../workflow/types.js";
import { claudePrReviewerCommand } from "./claude-pr-reviewer-command.js";
import { parsePrReviewerOutput } from "./pr-review-output-parser.js";
import { isRunnerAuthError, runProcess } from "./process-runner.js";
import { prReviewPrompt } from "./prompts/pr-reviewer.js";

export interface PrReviewProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  timedOut: boolean;
}

export interface PrReviewProcessInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  artifactDir: string;
}

export type PrReviewProcessRunner = (input: PrReviewProcessInput) => Promise<PrReviewProcessOutput>;

export interface ProjectReviewerRunnerOptions {
  runProcess?: PrReviewProcessRunner;
}

export class ProjectReviewerRunnerImpl implements ProjectReviewerRunner {
  private readonly runProcess: PrReviewProcessRunner;

  constructor(options: ProjectReviewerRunnerOptions = {}) {
    this.runProcess = options.runProcess ?? defaultProcessRunner;
  }

  async reviewProject(context: ProjectReviewContext): Promise<PrReviewResult> {
    const prompt = prReviewPrompt({
      pullRequest: context.pullRequest,
      shippedIssues: context.shippedIssues,
      diff: context.diff,
    });

    const result = await this.runProcess({
      prompt,
      cwd: context.project.repoRoot,
      timeoutMs: context.project.timeouts.reviewerMs,
      artifactDir: context.artifactDir,
    });

    if (result.timedOut) {
      return {
        outcome: "blocked",
        findings: [],
        summary: `Reviewer timed out after ${context.project.timeouts.reviewerMs}ms`,
        rawLogPath: result.stderrLogPath,
      };
    }

    if (result.exitCode !== 0) {
      if (isPrReviewAuthError(result.stderr)) {
        return {
          outcome: "blocked",
          findings: [],
          summary: `Reviewer authentication failed — re-authenticate and retry: ${truncate(result.stderr, 500)}`,
          rawLogPath: result.stderrLogPath,
          failureReason: "runner_auth_missing",
        };
      }
      return {
        outcome: "blocked",
        findings: [],
        summary: `Reviewer exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
      };
    }

    const parsed = parsePrReviewerOutput(result.stdout);
    if (!parsed.ok) {
      const summary =
        parsed.reason === "no_json"
          ? "Reviewer output did not contain valid JSON"
          : "Reviewer output JSON has unexpected shape";
      return {
        outcome: "blocked",
        findings: [],
        summary,
        rawLogPath: result.stdoutLogPath,
        failureReason: "review_unparseable",
      };
    }

    return {
      outcome: parsed.payload.outcome,
      findings: parsed.payload.findings,
      summary: parsed.payload.summary,
      rawLogPath: result.stdoutLogPath,
    };
  }
}

async function defaultProcessRunner(input: PrReviewProcessInput): Promise<PrReviewProcessOutput> {
  const { command, args } = claudePrReviewerCommand();
  const result = await runProcess({
    command,
    args,
    cwd: input.cwd,
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
    artifactDir: input.artifactDir,
    label: "pr-reviewer",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutLogPath: result.stdoutLogPath,
    stderrLogPath: result.stderrLogPath,
    timedOut: result.timedOut,
  };
}

function isPrReviewAuthError(stderr: string): boolean {
  if (isRunnerAuthError(stderr)) return true;
  return /\/login\b/i.test(stderr) && /authenticate/i.test(stderr);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
