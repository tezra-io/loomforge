import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runProcess, isRunnerAuthError } from "../../src/runners/process-runner.js";

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

  it("finds user npm-global binaries when the daemon PATH is sparse", async () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const userBin = join(tmpDir, ".npm-global", "bin");
    const fakeTool = join(userBin, "fake-agent");

    await mkdir(userBin, { recursive: true });
    await writeFile(fakeTool, "#!/bin/sh\necho user-bin-found\n", "utf8");
    await chmod(fakeTool, 0o755);

    try {
      process.env.HOME = tmpDir;
      process.env.PATH = "/usr/bin:/bin";

      const result = await runProcess({
        command: "fake-agent",
        args: [],
        cwd: tmpDir,
        timeoutMs: 5000,
        artifactDir: join(tmpDir, "logs"),
        label: "user-bin-test",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("user-bin-found");
    } finally {
      restoreEnv("HOME", previousHome);
      restoreEnv("PATH", previousPath);
    }
  });
});

function restoreEnv(name: "HOME" | "PATH", value: string | undefined): void {
  if (value === undefined) {
    if (name === "HOME") delete process.env.HOME;
    if (name === "PATH") delete process.env.PATH;
    return;
  }
  process.env[name] = value;
}

describe("isRunnerAuthError", () => {
  it.each([
    "Unauthorized: token expired",
    "Error: authentication required",
    "Authentication failed for 'https://github.com'",
    "Authentication error: invalid credentials",
    "Not authenticated — run `codex login`",
    "not logged in",
    "Token expired, please re-authenticate",
    "invalid api key",
    "invalid_api_key provided",
    "API key not found",
    "HTTP 401: Bad credentials",
    "Permission denied (publickey).",
    "remote: Bad credentials",
    "The requested URL returned error: 403 Forbidden",
    "could not read Username for 'https://github.com': terminal prompts disabled",
    "error 401 fetching resource",
  ])("detects auth error: %s", (stderr) => {
    expect(isRunnerAuthError(stderr)).toBe(true);
  });

  it.each([
    "syntax error on line 42",
    "ENOENT: no such file or directory",
    "permission denied",
    "segmentation fault",
    "",
    "Working on authentication tests",
    "port 4013 already in use",
  ])("ignores non-auth error: %s", (stderr) => {
    expect(isRunnerAuthError(stderr)).toBe(false);
  });
});
