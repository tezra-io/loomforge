import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import type {
  IssueSnapshot,
  RunAttemptRecord,
  RunRecord,
  WorkflowStepContext,
  WorkspaceSnapshot,
} from "../../src/workflow/types.js";
import { VerificationRunner } from "../../src/runners/verification-runner.js";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug: "test-project",
    repoRoot: "/tmp/fake-repo",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/tmp/fake-data",
    verification: {
      commands: [
        { name: "typecheck", command: "echo ok", timeoutMs: 10_000 },
        { name: "test", command: "echo ok", timeoutMs: 10_000 },
      ],
    },
    timeouts: {
      builderMs: 60_000,
      reviewerMs: 60_000,
      verificationMs: 30_000,
    },
    review: { maxRevisionLoops: 3, blockingSeverities: ["P0", "P1"] },
    linearStatuses: {
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      blocked: "Blocked",
    },
    ...overrides,
  };
}

function makeContext(project: ProjectConfig, workspace: WorkspaceSnapshot): WorkflowStepContext {
  const run: RunRecord = {
    id: "run-1",
    projectSlug: project.slug,
    issueId: "TEZ-1",
    state: "verifying",
    failureReason: null,
    revisionCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    queuePosition: null,
    issueSnapshot: null,
    workspace,
    attempts: [],
    events: [],
    handoff: null,
  };
  const issue: IssueSnapshot = {
    identifier: "TEZ-1",
    title: "Test issue",
    description: null,
    acceptanceCriteria: null,
    labels: [],
    comments: [],
    priority: null,
  };
  const attempt: RunAttemptRecord = {
    id: "attempt-1",
    runId: run.id,
    attemptNumber: 1,
    outcome: null,
    builderResult: null,
    verificationResult: null,
    reviewResult: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return { run, project, issue, workspace, attempt, revisionInput: null };
}

describe("VerificationRunner", () => {
  let tmpDir: string;
  let artifactDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "loom-verify-"));
    artifactDir = join(tmpDir, "artifacts");
    await mkdir(artifactDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when all commands succeed", async () => {
    const project = makeProject({
      verification: {
        commands: [
          { name: "typecheck", command: "echo typecheck-ok", timeoutMs: 10_000 },
          { name: "test", command: "echo test-ok", timeoutMs: 10_000 },
        ],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("pass");
    expect(result.commandResults).toHaveLength(2);
    expect(result.commandResults[0]?.outcome).toBe("pass");
    expect(result.commandResults[0]?.name).toBe("typecheck");
    expect(result.commandResults[1]?.outcome).toBe("pass");
    expect(result.commandResults[1]?.name).toBe("test");
  });

  it("fails when a command exits non-zero", async () => {
    const project = makeProject({
      verification: {
        commands: [
          { name: "typecheck", command: "echo ok", timeoutMs: 10_000 },
          { name: "test", command: "exit 1", timeoutMs: 10_000 },
        ],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("fail");
    expect(result.failureReason).toBe("verification_failed");
    expect(result.commandResults[0]?.outcome).toBe("pass");
    expect(result.commandResults[1]?.outcome).toBe("fail");
  });

  it("returns blocked when the binary is missing", async () => {
    const project = makeProject({
      verification: {
        commands: [
          {
            name: "missing-tool",
            command: "nonexistent-binary-xyz --version",
            timeoutMs: 10_000,
          },
        ],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("env_failure");
  });

  it("returns blocked when the cwd does not exist", async () => {
    const project = makeProject({
      verification: {
        commands: [{ name: "test", command: "echo ok", timeoutMs: 10_000 }],
      },
    });
    const workspace: WorkspaceSnapshot = {
      path: "/nonexistent/path/xyz",
      branchName: "dev",
    };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("env_failure");
  });

  it("fails on command timeout", async () => {
    const project = makeProject({
      verification: {
        commands: [{ name: "slow", command: "sleep 60", timeoutMs: 500 }],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("fail");
    expect(result.commandResults[0]?.outcome).toBe("fail");
  }, 10_000);

  it("runs all commands and aggregates failures", async () => {
    const scriptPath = join(tmpDir, "track.sh");
    await writeFile(scriptPath, '#!/bin/bash\necho "ran-$1"', { mode: 0o755 });

    const project = makeProject({
      verification: {
        commands: [
          { name: "first", command: `bash ${scriptPath} first`, timeoutMs: 10_000 },
          { name: "fail-here", command: "exit 1", timeoutMs: 10_000 },
          { name: "third", command: `bash ${scriptPath} third`, timeoutMs: 10_000 },
        ],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("fail");
    expect(result.commandResults).toHaveLength(3);
    expect(result.commandResults[0]?.outcome).toBe("pass");
    expect(result.commandResults[1]?.outcome).toBe("fail");
    expect(result.commandResults[2]?.outcome).toBe("pass");
  });

  it("writes log artifacts for each command", async () => {
    const project = makeProject({
      verification: {
        commands: [{ name: "typecheck", command: "echo hello-typecheck", timeoutMs: 10_000 }],
      },
    });
    const workspace: WorkspaceSnapshot = { path: tmpDir, branchName: "dev" };
    const ctx = makeContext(project, workspace);
    const runner = new VerificationRunner({ artifactDir });

    const result = await runner.verify(ctx);

    expect(result.outcome).toBe("pass");
    const logPath = result.commandResults[0]?.rawLogPath ?? "";
    expect(logPath).not.toBe("");
    expect(logPath).toContain(artifactDir);

    const { readFile: readF } = await import("node:fs/promises");
    const logContent = await readF(logPath, "utf8");
    expect(logContent).toContain("hello-typecheck");
  });
});
