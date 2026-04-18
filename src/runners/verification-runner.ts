import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

import { execaCommand } from "execa";

import type {
  VerificationCommandResult,
  VerificationResult,
  VerificationRunner as IVerificationRunner,
  WorkflowStepContext,
} from "../workflow/types.js";

export interface VerificationRunnerOptions {
  artifactDir: string;
}

export class VerificationRunner implements IVerificationRunner {
  private readonly artifactDir: string;

  constructor(options: VerificationRunnerOptions) {
    this.artifactDir = options.artifactDir;
  }

  async verify(context: WorkflowStepContext): Promise<VerificationResult> {
    const { project, workspace, run, attempt } = context;
    const commands = project.verification.commands;

    try {
      await access(workspace.path);
    } catch {
      return {
        outcome: "blocked",
        summary: `Workspace path does not exist: ${workspace.path}`,
        rawLogPath: "",
        commandResults: [],
        failureReason: "env_failure",
      };
    }

    const scopedDir = join(this.artifactDir, run.id, attempt.id);
    await mkdir(scopedDir, { recursive: true });

    const commandResults: VerificationCommandResult[] = [];
    let hasFailed = false;

    for (const cmd of commands) {
      const logPath = join(scopedDir, `verify-${cmd.name}.log`);

      try {
        const result = await execaCommand(cmd.command, {
          cwd: workspace.path,
          timeout: cmd.timeoutMs,
          shell: true,
          reject: false,
          all: true,
        });

        const exitCode = result.exitCode ?? 1;

        const logContent = [
          `command: ${cmd.command}`,
          `exit_code: ${exitCode}`,
          `---stdout---`,
          result.stdout,
          `---stderr---`,
          result.stderr,
        ].join("\n");

        await writeFile(logPath, logContent, "utf8");

        if (isEnvFailure(exitCode, result.stderr)) {
          return {
            outcome: "blocked",
            summary: `Environment failure running "${cmd.name}": ${result.stderr || "command not found"}`,
            rawLogPath: logPath,
            commandResults: [
              ...commandResults,
              { name: cmd.name, command: cmd.command, outcome: "fail", rawLogPath: logPath },
            ],
            failureReason: "env_failure",
          };
        }

        const passed = exitCode === 0;
        commandResults.push({
          name: cmd.name,
          command: cmd.command,
          outcome: passed ? "pass" : "fail",
          rawLogPath: logPath,
        });

        if (!passed) {
          hasFailed = true;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await writeFile(logPath, `error: ${message}`, "utf8");

        if (isSpawnError(error)) {
          return {
            outcome: "blocked",
            summary: `Environment failure running "${cmd.name}": ${message}`,
            rawLogPath: logPath,
            commandResults: [
              ...commandResults,
              { name: cmd.name, command: cmd.command, outcome: "fail", rawLogPath: logPath },
            ],
            failureReason: "env_failure",
          };
        }

        commandResults.push({
          name: cmd.name,
          command: cmd.command,
          outcome: "fail",
          rawLogPath: logPath,
        });
        hasFailed = true;
      }
    }

    const outcome = hasFailed ? "fail" : "pass";
    const summaryLogPath = join(scopedDir, "verify-summary.log");
    const summaryLines = commandResults.map((r) => `${r.name}: ${r.outcome}`);
    await writeFile(summaryLogPath, summaryLines.join("\n"), "utf8");

    return {
      outcome,
      summary: hasFailed
        ? `Verification failed: ${commandResults
            .filter((r) => r.outcome === "fail")
            .map((r) => r.name)
            .join(", ")}`
        : `All ${commandResults.length} verification commands passed`,
      rawLogPath: summaryLogPath,
      commandResults,
      ...(hasFailed ? { failureReason: "verification_failed" } : {}),
    };
  }
}

function isSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}

function isEnvFailure(exitCode: number, stderr: string): boolean {
  if (exitCode === 127) return true;
  if (exitCode !== 0 && stderr.includes("not found")) return true;
  return false;
}
