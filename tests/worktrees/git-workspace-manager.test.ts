import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";

import type { ProjectConfig } from "../../src/config/index.js";
import type { IssueSnapshot } from "../../src/workflow/types.js";
import { GitWorkspaceManager } from "../../src/worktrees/git-workspace-manager.js";

const issue: IssueSnapshot = {
  identifier: "TEZ-1",
  title: "Test issue",
  description: null,
  acceptanceCriteria: null,
  labels: [],
  comments: [],
  priority: null,
};

function makeProject(repoRoot: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug: "test-project",
    repoRoot,
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/tmp/fake-data",
    verification: {
      commands: [{ name: "test", command: "echo ok", timeoutMs: 10_000 }],
    },
    timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "# test\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
}

describe("GitWorkspaceManager", () => {
  let tmpDir: string;
  let manager: GitWorkspaceManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "loom-workspace-"));
    manager = new GitWorkspaceManager();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates dev branch from main and checks it out", async () => {
    await initRepo(tmpDir);
    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") return;
    expect(result.workspace.path).toBe(tmpDir);
    expect(result.workspace.branchName).toBe("dev");

    const branch = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir });
    expect(branch.stdout.trim()).toBe("dev");
  });

  it("reuses existing dev branch", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "branch", "dev");
    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") return;
    expect(result.workspace.branchName).toBe("dev");
  });

  it("returns blocked with dirty_workspace on uncommitted changes", async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, "dirty.txt"), "uncommitted\n");
    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.reason).toBe("dirty_workspace");
  });

  it("returns blocked with rebase_conflict on conflict", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "checkout", "-b", "dev");
    await writeFile(join(tmpDir, "conflict.txt"), "dev version\n");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "dev change");

    await git(tmpDir, "checkout", "main");
    await writeFile(join(tmpDir, "conflict.txt"), "main version\n");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "main change");

    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.reason).toBe("rebase_conflict");

    const branch = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir });
    expect(branch.stdout.trim()).toBe("dev");
  });

  it("returns blocked with env_failure for nonexistent repo", async () => {
    const project = makeProject("/nonexistent/repo/xyz");

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.reason).toBe("env_failure");
  });

  it("returns blocked with env_failure for non-git directory", async () => {
    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.reason).toBe("env_failure");
    expect(result.summary).toContain("Not a git repository");
  });

  it("returns env_failure for invalid default branch", async () => {
    await initRepo(tmpDir);
    const project = makeProject(tmpDir, { defaultBranch: "nonexistent-branch" });

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.reason).toBe("env_failure");
    expect(result.summary).toContain("Default branch does not exist");
  });

  it("rebases dev onto main with new commits on main", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "checkout", "-b", "dev");
    await writeFile(join(tmpDir, "dev-file.txt"), "dev work\n");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "dev work");

    await git(tmpDir, "checkout", "main");
    await writeFile(join(tmpDir, "main-file.txt"), "main update\n");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "main update");

    const project = makeProject(tmpDir);

    const result = await manager.prepareWorkspace(project, issue);

    expect(result.outcome).toBe("success");

    const log = await execa("git", ["log", "--oneline"], { cwd: tmpDir });
    expect(log.stdout).toContain("dev work");
    expect(log.stdout).toContain("main update");
  });
});
