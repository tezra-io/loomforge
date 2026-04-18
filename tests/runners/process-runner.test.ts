import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runProcess } from "../../src/runners/process-runner.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "loom-proc-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("runProcess", () => {
  it("captures stdout and stderr from a successful command", async () => {
    const result = await runProcess({
      command: "echo",
      args: ["hello"],
      cwd: tmpDir,
      timeoutMs: 5000,
      artifactDir: join(tmpDir, "logs"),
      label: "echo-test",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);

    const logContent = await readFile(result.stdoutLogPath, "utf8");
    expect(logContent.trim()).toBe("hello");
  });

  it("captures exit code from a failing command", async () => {
    const result = await runProcess({
      command: "sh",
      args: ["-c", "echo err >&2; exit 42"],
      cwd: tmpDir,
      timeoutMs: 5000,
      artifactDir: join(tmpDir, "logs"),
      label: "fail-test",
    });

    expect(result.exitCode).toBe(42);
    expect(result.stderr.trim()).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  it("detects timeout and writes partial logs", async () => {
    const result = await runProcess({
      command: "sleep",
      args: ["60"],
      cwd: tmpDir,
      timeoutMs: 500,
      artifactDir: join(tmpDir, "logs"),
      label: "timeout-test",
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 15_000);

  it("handles missing command gracefully", async () => {
    const result = await runProcess({
      command: "nonexistent-binary-xyz",
      args: [],
      cwd: tmpDir,
      timeoutMs: 5000,
      artifactDir: join(tmpDir, "logs"),
      label: "missing-cmd",
    });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("passes stdin to the child process", async () => {
    const result = await runProcess({
      command: "cat",
      args: [],
      cwd: tmpDir,
      stdin: "piped input",
      timeoutMs: 5000,
      artifactDir: join(tmpDir, "logs"),
      label: "stdin-test",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("piped input");
  });
});
