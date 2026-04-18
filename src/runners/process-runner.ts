import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

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
