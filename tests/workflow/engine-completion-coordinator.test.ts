import { describe, expect, it, vi } from "vitest";

import { parseProjectConfigRegistry } from "../../src/config/index.js";
import { WorkflowEngine } from "../../src/workflow/index.js";
import type {
  BuilderResult,
  ProjectCompletionCoordinator,
  ProjectCompletionRecord,
  ReviewResult,
} from "../../src/workflow/index.js";

const workspace = {
  path: "/repos/loom-worktree",
  branchName: "dev",
};

function createRegistry() {
  return parseProjectConfigRegistry(
    `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
    review:
      maxRevisionLoops: 2
      postPrReviewComments: true
`,
    { homeDir: "/Users/alice" },
  );
}

function builderSuccess(sha: string): BuilderResult {
  return {
    outcome: "success",
    summary: "built",
    changedFiles: ["src/x.ts"],
    commitSha: sha,
    rawLogPath: `/tmp/${sha}-builder.log`,
  };
}

function reviewPass(): ReviewResult {
  return {
    outcome: "pass",
    findings: [],
    summary: "ok",
    rawLogPath: "/tmp/reviewer.log",
  };
}

function buildCompletion(prUrl: string | null): ProjectCompletionRecord {
  return {
    id: "comp-1",
    projectSlug: "loom",
    state: "merge_ready",
    failureReason: null,
    prUrl,
    prNumber: prUrl ? 7 : null,
    baseBranch: "main",
    devBranch: "dev",
    baseSha: prUrl ? "base-sha" : null,
    devSha: prUrl ? "dev-sha" : null,
    shippedIssues: [],
    alreadyCompleteIssueIds: [],
    failedIssueIds: [],
    blockedIssueIds: [],
    cancelledIssueIds: [],
    reviewResult: null,
    prReviewOutcome: "skipped_no_findings",
    prReviewUrl: null,
    findingCounts: { p0: 0, p1: 0, p2: 0 },
    postPrReviewComments: true,
    blockingSeverities: ["P0", "P1"],
    reviewPartialPr: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:01.000Z",
    completedAt: "2026-05-01T00:00:01.000Z",
  };
}

describe("WorkflowEngine ↔ ProjectCompletionCoordinator integration", () => {
  it("invokes the coordinator on project completion and surfaces its prUrl", async () => {
    const completion = buildCompletion("https://github.com/org/loom/pull/7");
    const coordinator: ProjectCompletionCoordinator = {
      startOrResume: vi.fn(async () => completion),
      retry: vi.fn(async () => ({ outcome: "no_completion" as const })),
    };
    const onProjectComplete = vi.fn();

    const engine = new WorkflowEngine({
      registry: createRegistry(),
      linear: {
        fetchIssue: async () => ({
          identifier: "TEZ-1",
          title: "x",
          description: "d",
          acceptanceCriteria: "a",
          labels: [],
          comments: [],
          priority: null,
        }),
        listProjectIssues: async () => [],
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("sha-1"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/p.log" }),
      },
      reviewer: { review: async () => reviewPass() },
      projectCompletionCoordinator: coordinator,
      onProjectComplete,
    });

    const submitted = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });
    if (!submitted.accepted) throw new Error("submit not accepted");
    await engine.drainQueue();

    expect(engine.getRun(submitted.run.id).state).toBe("shipped");
    expect(coordinator.startOrResume).toHaveBeenCalledTimes(1);
    expect(onProjectComplete).toHaveBeenCalledTimes(1);
    const result = onProjectComplete.mock.calls[0]?.[0];
    expect(result?.pullRequestUrl).toBe("https://github.com/org/loom/pull/7");
    expect(result?.shipped).toEqual(["TEZ-1"]);
  });

  it("falls back to a null pullRequestUrl when the coordinator throws", async () => {
    const coordinator: ProjectCompletionCoordinator = {
      startOrResume: vi.fn(async () => {
        throw new Error("simulated coordinator failure");
      }),
      retry: vi.fn(async () => ({ outcome: "no_completion" as const })),
    };
    const onProjectComplete = vi.fn();

    const engine = new WorkflowEngine({
      registry: createRegistry(),
      linear: {
        fetchIssue: async () => ({
          identifier: "TEZ-1",
          title: "x",
          description: "d",
          acceptanceCriteria: "a",
          labels: [],
          comments: [],
          priority: null,
        }),
        listProjectIssues: async () => [],
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("sha-1"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/p.log" }),
      },
      reviewer: { review: async () => reviewPass() },
      projectCompletionCoordinator: coordinator,
      onProjectComplete,
    });

    const submitted = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });
    if (!submitted.accepted) throw new Error("submit not accepted");
    await engine.drainQueue();

    expect(engine.getRun(submitted.run.id).state).toBe("shipped");
    const result = onProjectComplete.mock.calls[0]?.[0];
    expect(result?.pullRequestUrl).toBeNull();
    expect(result?.shipped).toEqual(["TEZ-1"]);
  });
});
