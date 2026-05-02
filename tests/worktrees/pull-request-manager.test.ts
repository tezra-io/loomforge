import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import {
  GhPullRequestCreator,
  type CommandRunner,
} from "../../src/worktrees/pull-request-creator.js";

interface ExpectedCall {
  cmd: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function runnerFromScript(calls: ExpectedCall[]): {
  runner: CommandRunner;
  invocations: Array<{ cmd: string; args: string[] }>;
} {
  const invocations: Array<{ cmd: string; args: string[] }> = [];
  let index = 0;
  const runner: CommandRunner = async (cmd, args) => {
    invocations.push({ cmd, args });
    const expected = calls[index++];
    if (!expected) {
      throw new Error(`Unexpected command #${index}: ${cmd} ${args.join(" ")}`);
    }
    if (expected.cmd !== cmd) {
      throw new Error(`Expected command #${index} to be "${expected.cmd}" but got "${cmd}"`);
    }
    return {
      exitCode: expected.exitCode ?? 0,
      stdout: expected.stdout ?? "",
      stderr: expected.stderr ?? "",
    };
  };
  return { runner, invocations };
}

function buildProject(): ProjectConfig {
  return {
    slug: "loom",
    repoRoot: "/repos/loom",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/tmp/data",
    verification: {
      commands: [{ name: "test", command: "echo ok", timeoutMs: 1000 }],
    },
    timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
    review: {
      maxRevisionLoops: 3,
      blockingSeverities: ["P0", "P1"],
      postPrReviewComments: true,
      reviewPartialPr: false,
    },
    linearStatuses: {
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      blocked: "Blocked",
    },
  };
}

describe("GhPullRequestCreator.createOrUpdatePr", () => {
  it("creates a new PR when no open PR exists for base/head", async () => {
    const { runner, invocations } = runnerFromScript([
      { cmd: "git", args: ["push", "-u", "origin", "dev"], exitCode: 0 },
      // gh pr list -> empty
      {
        cmd: "gh",
        args: [
          "pr",
          "list",
          "--base",
          "main",
          "--head",
          "dev",
          "--state",
          "open",
          "--json",
          "number",
          "--limit",
          "1",
        ],
        exitCode: 0,
        stdout: "[]",
      },
      // gh pr create
      {
        cmd: "gh",
        args: [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "dev",
          "--title",
          "Project: loom",
          "--body",
          "body text",
        ],
        exitCode: 0,
        stdout: "https://github.com/org/loom/pull/7\n",
      },
      // gh pr view -> snapshot
      {
        cmd: "gh",
        args: [
          "pr",
          "view",
          "7",
          "--json",
          "url,number,baseRefName,headRefName,baseRefOid,headRefOid,body",
        ],
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/org/loom/pull/7",
          number: 7,
          baseRefName: "main",
          headRefName: "dev",
          baseRefOid: "base-sha-1",
          headRefOid: "dev-sha-1",
          body: "body text",
        }),
      },
    ]);
    const manager = new GhPullRequestCreator({ runner });

    const result = await manager.createOrUpdatePr(buildProject(), {
      title: "Project: loom",
      body: "body text",
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.pullRequest).toEqual({
        url: "https://github.com/org/loom/pull/7",
        number: 7,
        baseBranch: "main",
        devBranch: "dev",
        baseSha: "base-sha-1",
        devSha: "dev-sha-1",
        body: "body text",
      });
    }
    expect(invocations[0]?.cmd).toBe("git");
    expect(invocations).toHaveLength(4);
  });

  it("updates the existing PR when one is open for base/head", async () => {
    const { runner, invocations } = runnerFromScript([
      { cmd: "git", args: ["push", "-u", "origin", "dev"], exitCode: 0 },
      {
        cmd: "gh",
        args: [
          "pr",
          "list",
          "--base",
          "main",
          "--head",
          "dev",
          "--state",
          "open",
          "--json",
          "number",
          "--limit",
          "1",
        ],
        exitCode: 0,
        stdout: JSON.stringify([{ number: 7 }]),
      },
      {
        cmd: "gh",
        args: ["pr", "edit", "7", "--title", "Project: loom", "--body", "updated body"],
        exitCode: 0,
        stdout: "",
      },
      {
        cmd: "gh",
        args: [
          "pr",
          "view",
          "7",
          "--json",
          "url,number,baseRefName,headRefName,baseRefOid,headRefOid,body",
        ],
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/org/loom/pull/7",
          number: 7,
          baseRefName: "main",
          headRefName: "dev",
          baseRefOid: "base-sha-2",
          headRefOid: "dev-sha-2",
          body: "updated body",
        }),
      },
    ]);
    const manager = new GhPullRequestCreator({ runner });

    const result = await manager.createOrUpdatePr(buildProject(), {
      title: "Project: loom",
      body: "updated body",
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.pullRequest.number).toBe(7);
      expect(result.pullRequest.body).toBe("updated body");
      expect(result.pullRequest.devSha).toBe("dev-sha-2");
    }
    expect(invocations[2]?.args[0]).toBe("pr");
    expect(invocations[2]?.args[1]).toBe("edit");
  });

  it("returns push_failed when git push fails", async () => {
    const { runner } = runnerFromScript([
      {
        cmd: "git",
        args: ["push", "-u", "origin", "dev"],
        exitCode: 1,
        stderr: "rejected",
      },
    ]);
    const manager = new GhPullRequestCreator({ runner });

    const result = await manager.createOrUpdatePr(buildProject(), {
      title: "x",
      body: "y",
    });

    expect(result).toMatchObject({ outcome: "failed", reason: "push_failed" });
  });

  it("returns gh_failed when gh pr create fails", async () => {
    const { runner } = runnerFromScript([
      { cmd: "git", args: ["push", "-u", "origin", "dev"], exitCode: 0 },
      {
        cmd: "gh",
        args: [
          "pr",
          "list",
          "--base",
          "main",
          "--head",
          "dev",
          "--state",
          "open",
          "--json",
          "number",
          "--limit",
          "1",
        ],
        exitCode: 0,
        stdout: "[]",
      },
      {
        cmd: "gh",
        args: ["pr", "create", "--base", "main", "--head", "dev", "--title", "x", "--body", "y"],
        exitCode: 1,
        stderr: "no permission",
      },
    ]);
    const manager = new GhPullRequestCreator({ runner });

    const result = await manager.createOrUpdatePr(buildProject(), {
      title: "x",
      body: "y",
    });

    expect(result).toMatchObject({ outcome: "failed", reason: "gh_failed" });
  });
});
