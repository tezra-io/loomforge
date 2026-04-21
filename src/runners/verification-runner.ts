import { spawn } from "node:child_process";
import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

import type {
  VerificationCommandResult,
  VerificationResult,
  WorkflowStepContext,
} from "../workflow/types.js";

export interface VerificationRunnerOptions {
  artifactDir: string;
}

export class VerificationRunner {
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

      const result = await runShellCommand(cmd.command, workspace.path, cmd.timeoutMs);
      await writeFile(logPath, formatCommandLog(cmd.command, result), "utf8");

      if (result.timedOut) {
        return {
          outcome: "fail",
          summary: `Command "${cmd.name}" timed out after ${cmd.timeoutMs}ms`,
          rawLogPath: logPath,
          commandResults: [
            ...commandResults,
            { name: cmd.name, command: cmd.command, outcome: "fail", rawLogPath: logPath },
          ],
          failureReason: "timeout",
        };
      }

      if (isEnvFailure(result.exitCode, result.stderr)) {
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

      const passed = result.exitCode === 0;
      commandResults.push({
        name: cmd.name,
        command: cmd.command,
        outcome: passed ? "pass" : "fail",
        rawLogPath: logPath,
      });

      if (!passed) {
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

function isEnvFailure(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true;
  if (exitCode !== 0 && stderr.includes("not found")) return true;
  if (exitCode === null && stderr.includes("ENOENT")) return true;
  return false;
}

interface ShellCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      detached: process.platform !== "win32",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killShellCommand(child.pid);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(null, `${stderr}${error.message}`, timedOut);
    });
    child.on("close", (code) => {
      finish(code, stderr, timedOut);
    });

    function finish(exitCode: number | null, stderrText: string, didTimeOut: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr: stderrText, timedOut: didTimeOut });
    }
  });
}

function killShellCommand(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGKILL");
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch (error: unknown) {
    if (!isMissingProcess(error)) {
      throw error;
    }
  }
}

function formatCommandLog(command: string, result: ShellCommandResult): string {
  const exitCode = result.exitCode ?? "null";
  return [
    `command: ${command}`,
    `exit_code: ${exitCode}`,
    `timed_out: ${result.timedOut}`,
    `---stdout---`,
    result.stdout,
    `---stderr---`,
    result.stderr,
  ].join("\n");
}

function isMissingProcess(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}
