import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ReviewerRunnerImpl } from "../../src/runners/claude-reviewer-runner.js";
import type { WorkflowStepContext } from "../../src/workflow/types.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";

let tmpDir: string;
let repoDir: string;
let artifactDir: string;
let binDir: string;

function createContext(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  const project =
    parseProjectConfigRegistry(
      `
projects:
  - slug: test
    repoRoot: ${repoDir}
    defaultBranch: main
    timeouts:
      reviewerMs: 10000
    verification:
      commands:
        - name: test
          command: echo ok
`,
      { homeDir: tmpDir },
    ).projects[0] ??
    (() => {
      throw new Error("no project");
    })();

  return {
    run: {
      id: "run-1",
      projectSlug: "test",
      issueId: "TEZ-1",
      state: "reviewing",
      failureReason: null,
      revisionCount: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      queuePosition: null,
      issueSnapshot: null,
      workspace: null,
      attempts: [],
      events: [],
      handoff: null,
    },
    project,
    issue: {
      identifier: "TEZ-1",
      title: "Test issue",
      description: "Fix the thing",
      acceptanceCriteria: "It works",
      labels: [],
      comments: [],
      priority: null,
    },
    workspace: { path: repoDir, branchName: "dev" },
    attempt: {
      id: "attempt-1",
      runId: "run-1",
      attemptNumber: 1,
      outcome: null,
      builderResult: null,
      verificationResult: null,
      reviewResult: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    revisionInput: null,
    ...overrides,
  };
}

async function writeFakeBinary(name: string, script: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${script}`, "utf8");
  await chmod(path, 0o755);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "loom-claude-"));
  repoDir = join(tmpDir, "repo");
  artifactDir = join(tmpDir, "artifacts");
  binDir = join(tmpDir, "bin");

  await execa("mkdir", ["-p", binDir]);
  await execa("mkdir", ["-p", artifactDir]);
  await execa("git", ["init", repoDir]);
  await execa("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execa("git", ["-C", repoDir, "config", "user.name", "Test"]);
  await execa("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"]);
  await execa("git", ["-C", repoDir, "checkout", "-b", "dev"]);

  process.env.PATH = `${binDir}:${process.env.PATH}`;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ReviewerRunnerImpl", () => {
  it("returns pass when reviewer outputs passing JSON", async () => {
    const output = JSON.stringify({
      outcome: "pass",
      findings: [],
      summary: "Looks good",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe("Looks good");
  });

  it("returns revise with findings when reviewer requests changes", async () => {
    const output = JSON.stringify({
      outcome: "revise",
      findings: [
        {
          severity: "P0",
          title: "Missing check",
          detail: "No null check on input",
          file: "src/main.ts",
        },
        { severity: "P2", title: "Style", detail: "Consider renaming" },
      ],
      summary: "Needs fixes",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.at(0)?.severity).toBe("P0");
    expect(result.findings.at(1)?.severity).toBe("P2");
  });

  it("returns blocked when reviewer outputs invalid JSON", async () => {
    await writeFakeBinary("claude", "echo 'I could not review this code'");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("did not contain valid JSON");
  });

  it("returns blocked when reviewer exits non-zero", async () => {
    await writeFakeBinary("claude", "echo 'some error' >&2; exit 1");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("exit");
    expect(result.failureReason).toBeUndefined();
  });

  it("returns blocked with runner_auth_missing when reviewer exits with auth error", async () => {
    await writeFakeBinary("claude", "echo 'Unauthorized: token expired' >&2; exit 1");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("runner_auth_missing");
    expect(result.summary).toContain("authentication failed");
  });

  it("returns blocked on timeout", async () => {
    await writeFakeBinary("claude", "exec sleep 60");

    const project = createContext().project;
    project.timeouts.reviewerMs = 500;
    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext({ project }));

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("timed out");
  }, 15_000);

  it("extracts JSON from markdown fences", async () => {
    const json = JSON.stringify({ outcome: "pass", findings: [], summary: "OK" });
    await writeFakeBinary(
      "claude",
      `echo '\\x60\\x60\\x60json'; echo '${json}'; echo '\\x60\\x60\\x60'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
  });

  it("extracts JSON even when the reviewer emits prose with brace placeholders first", async () => {
    const json = JSON.stringify({
      outcome: "revise",
      findings: [{ severity: "P0", title: "Missing null check", detail: "Guard input" }],
      summary: "Needs fixes",
    });
    await writeFakeBinary(
      "claude",
      `printf '%s\\n%s\\n' 'Looking at the diff, I see issues with {variable} references.' '${json}'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.title).toBe("Missing null check");
  });

  it("filters out malformed findings", async () => {
    const output = JSON.stringify({
      outcome: "revise",
      findings: [
        { severity: "P0", title: "Valid", detail: "real finding" },
        { severity: "INVALID", title: "Bad severity" },
        { not_a_finding: true },
      ],
      summary: "Mixed findings",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.severity).toBe("P0");
  });

  it("receives prompt on stdin with verification evidence", async () => {
    const stdinLog = join(tmpDir, "stdin-capture.txt");
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "OK" });
    await writeFakeBinary("claude", `cat > "${stdinLog}" && echo '${output}'`);

    const ctx = createContext();
    ctx.attempt.verificationResult = {
      outcome: "pass",
      summary: "All passed",
      rawLogPath: "",
      commandResults: [
        { name: "test", command: "pnpm test", outcome: "pass", rawLogPath: "" },
        { name: "lint", command: "pnpm lint", outcome: "pass", rawLogPath: "" },
      ],
    };

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    await runner.review(ctx);

    const { readFile } = await import("node:fs/promises");
    const captured = await readFile(stdinLog, "utf8");
    expect(captured).toContain("staff engineer");
    expect(captured).toContain("Integration");
    expect(captured).toContain("Completeness");
    expect(captured).toContain("Verification Results");
    expect(captured).toContain("test: pass");
    expect(captured).toContain("lint: pass");
  });
});
