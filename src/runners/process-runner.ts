import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import { childProcessEnv } from "./path-env.js";

export interface ProcessRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  artifactDir: string;
  label: string;
}

export interface ProcessRunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export async function runProcess(options: ProcessRunnerOptions): Promise<ProcessRunnerResult> {
  const logDir = options.artifactDir;
  await mkdir(logDir, { recursive: true });

  const stdoutLogPath = join(logDir, `${options.label}-stdout.log`);
  const stderrLogPath = join(logDir, `${options.label}-stderr.log`);

  try {
    const result = await execa(options.command, options.args, {
      cwd: options.cwd,
      env: childProcessEnv(),
      timeout: options.timeoutMs,
      input: options.stdin,
      reject: false,
      all: false,
    });

    const stderr = result.stderr || (result.failed ? (result.message ?? "") : "");

    await Promise.all([
      writeFile(stdoutLogPath, result.stdout, "utf8"),
      writeFile(stderrLogPath, stderr, "utf8"),
    ]);

    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr,
      timedOut: result.timedOut === true,
      stdoutLogPath,
      stderrLogPath,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(stderrLogPath, message, "utf8");
    await writeFile(stdoutLogPath, "", "utf8");

    const timedOut =
      typeof error === "object" &&
      error !== null &&
      "timedOut" in error &&
      (error as { timedOut: boolean }).timedOut === true;

    return {
      exitCode: null,
      stdout: "",
      stderr: message,
      timedOut,
      stdoutLogPath,
      stderrLogPath,
    };
  }
}

export function isRunnerAuthError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("authentication failed") ||
    lower.includes("authentication required") ||
    lower.includes("authentication error") ||
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("unauthorized") ||
    lower.includes("token expired") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("api key not found") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("bad credentials") ||
    lower.includes("403 forbidden") ||
    lower.includes("terminal prompts disabled") ||
    /\b401\b/.test(lower)
  );
}
