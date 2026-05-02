import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import {
  GitProjectDiffSnapshotter,
  type DiffCommandRunner,
} from "../../src/workflow/project-diff-snapshotter.js";

interface ScriptedCall {
  cmd: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function runnerFromScript(calls: ScriptedCall[]): {
  runner: DiffCommandRunner;
  invocations: Array<{ cmd: string; args: string[] }>;
} {
  const invocations: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const runner: DiffCommandRunner = async (cmd, args) => {
    invocations.push({ cmd, args });
    const expected = calls[i++];
    if (!expected) {
      throw new Error(`Unexpected command #${i}: ${cmd} ${args.join(" ")}`);
    }
    if (expected.cmd !== cmd) {
      throw new Error(`Expected #${i} to be "${expected.cmd}" but got "${cmd}"`);
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

describe("GitProjectDiffSnapshotter", () => {
  it("fetches refs and returns the diff between origin/<base>...origin/<dev>", async () => {
    const { runner, invocations } = runnerFromScript([
      { cmd: "git", args: ["fetch", "origin", "main", "dev"], exitCode: 0 },
      {
        cmd: "git",
        args: ["rev-parse", "origin/main"],
        exitCode: 0,
        stdout: "base-sha\n",
      },
      {
        cmd: "git",
        args: ["rev-parse", "origin/dev"],
        exitCode: 0,
        stdout: "dev-sha\n",
      },
      {
        cmd: "git",
        args: ["diff", "origin/main...origin/dev"],
        exitCode: 0,
        stdout: "diff --git a/x b/x\n+added\n",
      },
    ]);
    const snapshotter = new GitProjectDiffSnapshotter({ runner });

    const result = await snapshotter.snapshot(buildProject());

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.baseSha).toBe("base-sha");
      expect(result.devSha).toBe("dev-sha");
      expect(result.diff).toContain("+added");
    }
    expect(invocations).toHaveLength(4);
  });

  it("returns fetch_failed when git fetch errors", async () => {
    const { runner } = runnerFromScript([
      {
        cmd: "git",
        args: ["fetch", "origin", "main", "dev"],
        exitCode: 1,
        stderr: "auth required",
      },
    ]);
    const snapshotter = new GitProjectDiffSnapshotter({ runner });

    const result = await snapshotter.snapshot(buildProject());

    expect(result).toMatchObject({ outcome: "unavailable", reason: "fetch_failed" });
  });

  it("returns diff_failed when git diff errors", async () => {
    const { runner } = runnerFromScript([
      { cmd: "git", args: ["fetch", "origin", "main", "dev"], exitCode: 0 },
      {
        cmd: "git",
        args: ["rev-parse", "origin/main"],
        exitCode: 0,
        stdout: "base-sha\n",
      },
      {
        cmd: "git",
        args: ["rev-parse", "origin/dev"],
        exitCode: 0,
        stdout: "dev-sha\n",
      },
      {
        cmd: "git",
        args: ["diff", "origin/main...origin/dev"],
        exitCode: 128,
        stderr: "ambiguous ref",
      },
    ]);
    const snapshotter = new GitProjectDiffSnapshotter({ runner });

    const result = await snapshotter.snapshot(buildProject());

    expect(result).toMatchObject({ outcome: "unavailable", reason: "diff_failed" });
  });

  it("returns success with empty diff when origin/<base>...origin/<dev> has no changes", async () => {
    const { runner } = runnerFromScript([
      { cmd: "git", args: ["fetch", "origin", "main", "dev"], exitCode: 0 },
      {
        cmd: "git",
        args: ["rev-parse", "origin/main"],
        exitCode: 0,
        stdout: "shared\n",
      },
      {
        cmd: "git",
        args: ["rev-parse", "origin/dev"],
        exitCode: 0,
        stdout: "shared\n",
      },
      {
        cmd: "git",
        args: ["diff", "origin/main...origin/dev"],
        exitCode: 0,
        stdout: "",
      },
    ]);
    const snapshotter = new GitProjectDiffSnapshotter({ runner });

    const result = await snapshotter.snapshot(buildProject());

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.diff).toBe("");
      expect(result.baseSha).toBe("shared");
      expect(result.devSha).toBe("shared");
    }
  });
});
