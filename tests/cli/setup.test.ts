import { describe, expect, it, vi } from "vitest";

import { runSetup } from "../../src/cli/setup.js";

describe("runSetup", () => {
  it("detects LINEAR_API_KEY when config still has the scaffold placeholder", async () => {
    const writes: string[] = [];
    let exitCode: number | undefined;

    await runSetup({
      env: { LINEAR_API_KEY: "lin_api_env_value" },
      execFile: (_file, _commandArgs, _options) => "",
      fileExists: (path) =>
        path.endsWith("config.yaml") || path.endsWith("loom.yaml") || path.endsWith("/loom"),
      homeDir: () => "/Users/alice",
      isInteractive: false,
      readTextFile: (path, _encoding) =>
        path.endsWith("config.yaml")
          ? "linear:\n  apiKey: lin_api_YOUR_KEY_HERE\n"
          : "projects:\n  - slug: loom\n",
      setExitCode: (code) => {
        exitCode = code;
      },
      write: (text) => {
        writes.push(text);
      },
    });

    expect(writes.join("")).toContain("Linear API key configured via");
    expect(writes.join("")).toContain("LINEAR_API_KEY");
    expect(exitCode).toBe(1);
  });

  it("skips agent selection without an interactive terminal", async () => {
    const writes: string[] = [];
    let exitCode: number | undefined;
    const execFile = vi.fn(
      (
        _file: string,
        _commandArgs: readonly string[],
        _options: { stdio: "inherit"; timeout: number },
      ) => "",
    );

    await runSetup({
      execFile,
      fileExists: (path) =>
        path.endsWith("config.yaml") || path.endsWith("loom.yaml") || path.endsWith("/loom"),
      homeDir: () => "/Users/alice",
      isInteractive: false,
      readTextFile: (path, _encoding) =>
        path.endsWith("config.yaml")
          ? "linear:\n  apiKey: lin_api_real\n"
          : "projects:\n  - slug: loom\n",
      setExitCode: (code) => {
        exitCode = code;
      },
      write: (text) => {
        writes.push(text);
      },
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("Agent selection skipped — interactive terminal required");
    expect(writes.join("")).toContain("Rerun");
    expect(exitCode).toBe(1);
  });

  it("shows agents in short pages and installs the selected agents", async () => {
    const writes: string[] = [];
    let exitCode: number | undefined;
    let command: string | undefined;
    let args: string[] | undefined;
    const answers = ["more", "7,8"];

    await runSetup({
      execFile: (
        file: string,
        commandArgs: readonly string[],
        _options: { stdio: "inherit"; timeout: number },
      ) => {
        command = file;
        args = [...commandArgs];
        return "";
      },
      fileExists: (path) =>
        path.endsWith("config.yaml") || path.endsWith("loom.yaml") || path.endsWith("/loom"),
      homeDir: () => "/Users/alice",
      isInteractive: true,
      readTextFile: (path, _encoding) =>
        path.endsWith("config.yaml")
          ? "linear:\n  apiKey: lin_api_real\n"
          : "projects:\n  - slug: loom\n",
      setExitCode: (code) => {
        exitCode = code;
      },
      prompt: async () => {
        return answers.shift() ?? "";
      },
      write: (text) => {
        writes.push(text);
      },
    });

    expect(command).toBe("npx");
    expect(args).toEqual([
      "--yes",
      "skills",
      "add",
      expect.stringContaining("/loom"),
      "--global",
      "--skill",
      "loomforge",
      "--agent",
      "windsurf",
      "--agent",
      "continue",
    ]);
    expect(writes.join("")).toContain("Showing 1-6 of 45");
    expect(writes.join("")).toContain("Type");
    expect(writes.join("")).toContain("Showing 7-12 of 45");
    expect(writes.join("")).not.toContain("AdaL");
    expect(writes.join("")).toContain("Agent skill installed for");
    expect(exitCode).toBeUndefined();
  });

  it("surfaces the install command and error when skill install fails", async () => {
    const writes: string[] = [];
    let exitCode: number | undefined;

    await runSetup({
      execFile: (_file, _commandArgs, _options) => {
        throw new Error("network down");
      },
      fileExists: (path) =>
        path.endsWith("config.yaml") || path.endsWith("loom.yaml") || path.endsWith("/loom"),
      homeDir: () => "/Users/alice",
      isInteractive: true,
      prompt: async () => "claude-code",
      readTextFile: (path, _encoding) =>
        path.endsWith("config.yaml")
          ? "linear:\n  apiKey: lin_api_real\n"
          : "projects:\n  - slug: loom\n",
      setExitCode: (code) => {
        exitCode = code;
      },
      write: (text) => {
        writes.push(text);
      },
    });

    expect(writes.join("")).toContain("Agent skill install failed — network down");
    expect(writes.join("")).toContain("Command:");
    expect(writes.join("")).toContain("--skill loomforge");
    expect(writes.join("")).toContain("--agent claude-code");
    expect(exitCode).toBe(1);
  });
});
