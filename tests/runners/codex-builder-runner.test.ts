import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { CodexBuilderRunner } from "../../src/runners/codex-builder-runner.js";
import type { WorkflowStepContext, PushContext } from "../../src/workflow/types.js";
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
      builderMs: 10000
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
      state: "building",
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
  tmpDir = await mkdtemp(join(tmpdir(), "loom-codex-"));
  repoDir = join(tmpDir, "repo");
  artifactDir = join(tmpDir, "artifacts");
  binDir = join(tmpDir, "bin");

  await execa("mkdir", ["-p", binDir]);
  await execa("mkdir", ["-p", artifactDir]);
  await execa("git", ["init", repoDir]);
  await execa("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"]);
  await execa("git", ["-C", repoDir, "checkout", "-b", "dev"]);

  process.env.PATH = `${binDir}:${process.env.PATH}`;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("CodexBuilderRunner", () => {
  it("returns success when codex creates a commit", async () => {
    await writeFakeBinary(
      "codex",
      `cd "${repoDir}" && echo "change" > file.txt && git add file.txt && git commit -m "feat: change"`,
    );

    const runner = new CodexBuilderRunner({ artifactDir });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("success");
    expect(result.commitSha).toBeTruthy();
    expect(result.changedFiles).toContain("file.txt");
  });

  it("returns failed when codex exits non-zero", async () => {
    await writeFakeBinary("codex", "echo 'error' >&2; exit 1");

    const runner = new CodexBuilderRunner({ artifactDir });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.commitSha).toBeNull();
  });

  it("returns failed with timeout when codex exceeds time limit", async () => {
    await writeFakeBinary("codex", "exec sleep 60");

    const project = createContext().project;
    project.timeouts.builderMs = 500;
    const runner = new CodexBuilderRunner({ artifactDir });
    const result = await runner.build(createContext({ project }));

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("timeout");
  }, 15_000);

  it("returns failed when codex succeeds but no commit is created", async () => {
    await writeFakeBinary("codex", "echo 'done'");

    const runner = new CodexBuilderRunner({ artifactDir });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.summary).toContain("no new commit");
  });
});

describe("CodexBuilderRunner push", () => {
  it("returns success when push exits cleanly", async () => {
    await writeFakeBinary("codex", "echo 'pushed'");

    const runner = new CodexBuilderRunner({ artifactDir });
    const pushCtx: PushContext = {
      run: createContext().run,
      project: createContext().project,
      issue: createContext().issue,
      workspace: createContext().workspace,
      attempt: createContext().attempt,
    };
    const result = await runner.push(pushCtx);

    expect(result.outcome).toBe("success");
  });

  it("returns failed when push exits non-zero", async () => {
    await writeFakeBinary("codex", "echo 'push error' >&2; exit 1");

    const runner = new CodexBuilderRunner({ artifactDir });
    const pushCtx: PushContext = {
      run: createContext().run,
      project: createContext().project,
      issue: createContext().issue,
      workspace: createContext().workspace,
      attempt: createContext().attempt,
    };
    const result = await runner.push(pushCtx);

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("push_failed");
  });
});
