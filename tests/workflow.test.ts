import { describe, expect, it } from "vitest";

import { parseProjectConfigRegistry } from "../src/config/index.js";
import { SqliteRunStore } from "../src/db/index.js";
import { WorkflowEngine } from "../src/workflow/index.js";
import type {
  BuilderResult,
  LinearIssueSummary,
  PrepareWorkspaceResult,
  ProjectCompletionResult,
  ReviewResult,
  WorkflowRunStore,
  WorkflowStepContext,
} from "../src/workflow/index.js";

const issue = {
  identifier: "TEZ-1",
  title: "Build workflow engine",
  description: "Implement the core workflow engine.",
  acceptanceCriteria: "Runs build, review, and push.",
  labels: ["loom"],
  comments: [],
  priority: "High",
};

const workspace = {
  path: "/Users/alice/.loomforge/worktrees/loom",
  branchName: "dev",
};

function createIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

function createClock(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `2026-04-15T00:00:${String(next).padStart(2, "0")}.000Z`;
  };
}

function createRegistry(maxRevisionLoops = 2) {
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
      maxRevisionLoops: ${maxRevisionLoops}
`,
    { homeDir: "/Users/alice" },
  );
}

function builderSuccess(commitSha: string): BuilderResult {
  return {
    outcome: "success",
    summary: "built",
    changedFiles: ["src/workflow/engine.ts"],
    commitSha,
    rawLogPath: `/tmp/${commitSha}-builder.log`,
  };
}

function reviewPass(): ReviewResult {
  return {
    outcome: "pass",
    findings: [],
    summary: "review passed",
    rawLogPath: "/tmp/review.log",
  };
}

function reviewRevise(): ReviewResult {
  return {
    outcome: "revise",
    findings: [
      {
        severity: "P0",
        title: "Missing state transition",
        detail: "The implementation skips review.",
      },
    ],
    summary: "review found blockers",
    rawLogPath: "/tmp/review-fail.log",
  };
}

function createEngine(
  options: {
    maxRevisionLoops?: number;
    newId?: () => string;
    prepareResult?: PrepareWorkspaceResult;
    store?: WorkflowRunStore;
    reviewResults?: ReviewResult[];
  } = {},
) {
  const buildContexts: WorkflowStepContext[] = [];
  const linearUpdates: string[] = [];
  const reviewResults = [...(options.reviewResults ?? [reviewPass()])];
  let buildCount = 0;

  const engine = new WorkflowEngine({
    registry: createRegistry(options.maxRevisionLoops),
    newId: options.newId ?? createIds(),
    now: createClock(),
    store: options.store,
    linear: {
      fetchIssue: async () => issue,
      listProjectIssues: async () => [],
      updateIssueStatus: async (_project, _issue, statusName) => {
        linearUpdates.push(statusName);
      },
    },
    worktrees: {
      prepareWorkspace: async () => options.prepareResult ?? { outcome: "success", workspace },
      cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
    },
    builder: {
      build: async (context) => {
        buildCount += 1;
        buildContexts.push(context);
        return builderSuccess(`sha-${buildCount}`);
      },
      push: async () => ({
        outcome: "success",
        summary: "pushed",
        rawLogPath: "/tmp/push.log",
      }),
    },
    reviewer: {
      review: async () => reviewResults.shift() ?? reviewPass(),
    },
  });

  return { buildContexts, engine, linearUpdates };
}

function submitRun(engine: WorkflowEngine): string {
  const submitted = engine.submitRun({
    projectSlug: "loom",
    issueId: "TEZ-1",
    executionMode: "enqueue",
  });

  if (!submitted.accepted) {
    throw new Error("Expected run submission to be accepted");
  }

  return submitted.run.id;
}

describe("workflow engine", () => {
  it("runs the happy path through build, review, push, and Linear Done", async () => {
    const { engine, linearUpdates } = createEngine();
    const runId = submitRun(engine);

    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("shipped");
    expect(run.failureReason).toBeNull();
    expect(run.attempts).toHaveLength(1);
    expect(run.handoff).toMatchObject({
      version: 1,
      status: "shipped",
      workspacePath: workspace.path,
      branchName: "dev",
      commitShas: ["sha-1"],
      recommendedNextAction: "merge",
    });
    expect(linearUpdates).toEqual(["In Progress", "In Progress", "In Review", "Done"]);
    expect(run.events.map((event) => event.state)).toContain("ready_for_ship");
  });

  it("rebuilds with review findings and pushes after revision", async () => {
    const { engine, buildContexts } = createEngine({
      reviewResults: [reviewRevise()],
    });
    const runId = submitRun(engine);

    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("shipped");
    expect(run.attempts).toHaveLength(2);
    expect(buildContexts[1]?.revisionInput).toBeTruthy();
    expect(buildContexts[1]?.revisionInput?.findings[0]?.severity).toBe("P0");
  });

  it("rejects run_now_if_idle when work is already queued", () => {
    const { engine } = createEngine();
    const first = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });

    if (!first.accepted) {
      throw new Error("Expected first run to be accepted");
    }

    const second = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-2",
      executionMode: "run_now_if_idle",
    });

    expect(second).toMatchObject({
      accepted: false,
      reason: "busy",
      queuedRunIds: [first.run.id],
    });
  });

  it("defaults RunRecord.source to 'linear' when source is not provided", () => {
    const { engine } = createEngine();
    const result = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.run.source).toBe("linear");
  });

  it("records RunRecord.source='adhoc' when input.source='adhoc'", () => {
    const { engine } = createEngine();
    const result = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-2",
      executionMode: "enqueue",
      source: "adhoc",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.run.source).toBe("adhoc");
  });

  it("blocks before build when workspace preparation reports a rebase conflict", async () => {
    const { buildContexts, engine } = createEngine({
      prepareResult: {
        outcome: "blocked",
        reason: "rebase_conflict",
        summary: "dev could not rebase onto main",
      },
    });
    const runId = submitRun(engine);

    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("blocked");
    expect(run.failureReason).toBe("rebase_conflict");
    expect(run.attempts).toHaveLength(0);
    expect(buildContexts).toHaveLength(0);
  });

  it("persists run snapshots through the workflow store", async () => {
    const store = SqliteRunStore.open(":memory:");

    try {
      const { engine } = createEngine({ store });
      const runId = submitRun(engine);

      await engine.drainQueue();

      const stored = store.getRun(runId);
      expect(stored).toMatchObject({
        id: runId,
        state: "shipped",
        queuePosition: null,
        handoff: {
          version: 1,
          commitShas: ["sha-1"],
        },
      });
      expect(stored?.attempts).toHaveLength(1);
      expect(stored?.events.map((event) => event.state)).toContain("shipped");
      expect(store.listQueuedRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("recovers persisted queued runs on engine bootstrap", async () => {
    const store = SqliteRunStore.open(":memory:");
    const newId = createIds();

    try {
      const first = createEngine({ newId, store });
      const runId = submitRun(first.engine);

      const second = createEngine({ newId, store });

      expect(second.engine.getQueue().map((run) => run.id)).toEqual([runId]);

      await second.engine.drainQueue();

      expect(store.getRun(runId)).toMatchObject({
        state: "shipped",
        queuePosition: null,
      });
    } finally {
      store.close();
    }
  });

  it("requeues persisted in-flight runs for restart recovery", async () => {
    const store = SqliteRunStore.open(":memory:");
    const newId = createIds();

    try {
      const first = createEngine({ newId, store });
      const runId = submitRun(first.engine);
      const interrupted = first.engine.getRun(runId);
      interrupted.state = "building";
      interrupted.queuePosition = null;
      store.saveRun(interrupted);

      const second = createEngine({ newId, store });
      const recovered = second.engine.getRun(runId);

      expect(second.engine.getQueue().map((run) => run.id)).toEqual([runId]);
      expect(recovered).toMatchObject({
        state: "queued",
        failureReason: null,
        queuePosition: 1,
      });
      expect(recovered.events.at(-1)).toMatchObject({
        state: "queued",
        details: {
          recoveryReason: "daemon_restart",
          recoveredFromState: "building",
        },
      });

      await second.engine.drainQueue();

      const stored = store.getRun(runId);
      expect(stored?.state).toBe("shipped");
      expect(stored?.attempts).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("retries a blocked run and resets all attempt state", async () => {
    const { engine } = createEngine({
      prepareResult: {
        outcome: "blocked",
        reason: "dirty_workspace",
        summary: "workspace dirty",
      },
    });
    const runId = submitRun(engine);
    await engine.drainQueue();

    const blocked = engine.getRun(runId);
    expect(blocked.state).toBe("blocked");

    const retried = engine.retryRun(runId);
    expect(retried.state).toBe("queued");
    expect(retried.queuePosition).toBe(1);
    expect(retried.failureReason).toBeNull();
    expect(retried.revisionCount).toBe(0);
    expect(retried.attempts).toHaveLength(0);
    expect(retried.handoff).toBeNull();
    expect(retried.workspace).toBeNull();

    const retryEvent = retried.events.at(-1);
    expect(retryEvent).toMatchObject({
      state: "queued",
      details: { retryFromState: "blocked" },
    });
  });

  it("throws when retrying a queued run", () => {
    const { engine } = createEngine();
    const runId = submitRun(engine);
    expect(() => engine.retryRun(runId)).toThrow("Cannot retry run in state: queued");
  });

  it("throws when retrying a shipped run", async () => {
    const { engine } = createEngine();
    const runId = submitRun(engine);
    await engine.drainQueue();
    expect(engine.getRun(runId).state).toBe("shipped");
    expect(() => engine.retryRun(runId)).toThrow("Cannot retry run in state: shipped");
  });

  it("throws when retrying a cancelled run", () => {
    const { engine } = createEngine();
    const runId = submitRun(engine);
    engine.cancelRun(runId);
    expect(() => engine.retryRun(runId)).toThrow("Cannot retry run in state: cancelled");
  });

  it("retried run executes successfully through the full workflow", async () => {
    let prepareCount = 0;
    const newId = createIds();
    const engine = new WorkflowEngine({
      registry: createRegistry(),
      newId,
      now: createClock(),
      linear: {
        fetchIssue: async () => issue,
        listProjectIssues: async () => [],
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => {
          prepareCount += 1;
          if (prepareCount === 1) {
            return {
              outcome: "blocked" as const,
              reason: "dirty_workspace" as const,
              summary: "workspace dirty",
            };
          }
          return { outcome: "success" as const, workspace };
        },
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("sha-retry"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/push.log" }),
      },

      reviewer: { review: async () => reviewPass() },
    });

    const runId = submitRun(engine);
    await engine.drainQueue();
    expect(engine.getRun(runId).state).toBe("blocked");

    engine.retryRun(runId);
    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("shipped");
    expect(run.attempts).toHaveLength(1);
    expect(prepareCount).toBe(2);
  });

  it("cancels a queued run immediately", () => {
    const { engine } = createEngine();
    const runId = submitRun(engine);

    const cancelled = engine.cancelRun(runId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.failureReason).toBe("operator_cancel");
    expect(engine.getQueue()).toHaveLength(0);
  });

  it("cancel is idempotent on terminal runs", async () => {
    const { engine } = createEngine();
    const runId = submitRun(engine);
    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("shipped");

    const result = engine.cancelRun(runId);
    expect(result.state).toBe("shipped");
  });
});

function createRegistryWithTeamKey() {
  return parseProjectConfigRegistry(
    `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    linearTeamKey: TEZ
    verification:
      commands:
        - name: test
          command: pnpm test
`,
    { homeDir: "/Users/alice" },
  );
}

describe("submitProject", () => {
  it("enqueues all actionable issues from Linear", async () => {
    const linearIssues: LinearIssueSummary[] = [
      { identifier: "TEZ-1", title: "First", priority: 1, number: 1 },
      { identifier: "TEZ-2", title: "Second", priority: 2, number: 2 },
    ];

    const engine = new WorkflowEngine({
      registry: createRegistryWithTeamKey(),
      newId: createIds(),
      now: createClock(),
      linear: {
        fetchIssue: async () => issue,
        listProjectIssues: async () => linearIssues,
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("abc123"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/push.log" }),
      },

      reviewer: { review: async () => reviewPass() },
    });

    const result = await engine.submitProject("loom");

    expect(result.totalIssues).toBe(2);
    expect(result.enqueued).toHaveLength(2);
    expect(result.enqueued[0]?.issueId).toBe("TEZ-1");
    expect(result.enqueued[1]?.issueId).toBe("TEZ-2");
    expect(result.skipped).toHaveLength(0);
    expect(engine.getQueue()).toHaveLength(2);
  });

  it("skips issues that already have active runs", async () => {
    const linearIssues: LinearIssueSummary[] = [
      { identifier: "TEZ-1", title: "First", priority: 1, number: 1 },
      { identifier: "TEZ-2", title: "Second", priority: 2, number: 2 },
    ];

    const engine = new WorkflowEngine({
      registry: createRegistryWithTeamKey(),
      newId: createIds(),
      now: createClock(),
      linear: {
        fetchIssue: async () => issue,
        listProjectIssues: async () => linearIssues,
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("abc123"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/push.log" }),
      },

      reviewer: { review: async () => reviewPass() },
    });

    engine.submitRun({ projectSlug: "loom", issueId: "TEZ-1", executionMode: "enqueue" });

    const result = await engine.submitProject("loom");

    expect(result.totalIssues).toBe(2);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]?.issueId).toBe("TEZ-2");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.issueId).toBe("TEZ-1");
    expect(result.skipped[0]?.reason).toBe("already_active");
  });

  it("returns empty when no actionable issues exist", async () => {
    const engine = new WorkflowEngine({
      registry: createRegistryWithTeamKey(),
      newId: createIds(),
      now: createClock(),
      linear: {
        fetchIssue: async () => issue,
        listProjectIssues: async () => [],
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("abc123"),
        push: async () => ({ outcome: "success", summary: "pushed", rawLogPath: "/tmp/push.log" }),
      },

      reviewer: { review: async () => reviewPass() },
    });

    const result = await engine.submitProject("loom");

    expect(result.totalIssues).toBe(0);
    expect(result.enqueued).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(engine.getQueue()).toHaveLength(0);
  });
});

describe("setRegistry", () => {
  it("makes newly registered projects available without restart", () => {
    const { engine } = createEngine();

    expect(() => engine.getProjectStatus("kayak")).toThrow(/Unknown project slug/);

    const expanded = parseProjectConfigRegistry(
      `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
  - slug: kayak
    repoRoot: /repos/kayak
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
`,
      { homeDir: "/Users/alice" },
    );

    engine.setRegistry(expanded);

    const status = engine.getProjectStatus("kayak");
    expect(status.done).toBe(false);
    expect(status.shipped).toEqual([]);
  });
});

describe("project completion dedupe by issue", () => {
  it("treats a re-submitted run that ships as the canonical outcome", async () => {
    const completions: ProjectCompletionResult[] = [];
    let pushCount = 0;

    const engine = new WorkflowEngine({
      registry: createRegistry(),
      newId: createIds(),
      now: createClock(),
      onProjectComplete: (result) => completions.push(result),
      linear: {
        fetchIssue: async () => issue,
        listProjectIssues: async () => [],
        updateIssueStatus: async () => {},
      },
      worktrees: {
        prepareWorkspace: async () => ({ outcome: "success", workspace }),
        cleanupWorkspace: async () => ({ outcome: "success", summary: "cleaned" }),
      },
      builder: {
        build: async () => builderSuccess("sha"),
        push: async () => {
          pushCount += 1;
          if (pushCount === 1) {
            return {
              outcome: "failed",
              summary: "push rejected",
              rawLogPath: "/tmp/push.log",
              failureReason: "push_failed",
            };
          }
          return { outcome: "success", summary: "pushed", rawLogPath: "/tmp/push.log" };
        },
      },
      reviewer: { review: async () => reviewPass() },
    });

    const first = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });
    if (!first.accepted) throw new Error("first submit not accepted");
    await engine.drainQueue();
    expect(engine.getRun(first.run.id).state).toBe("failed");

    const second = engine.submitRun({
      projectSlug: "loom",
      issueId: "TEZ-1",
      executionMode: "enqueue",
    });
    if (!second.accepted) throw new Error("second submit not accepted");
    await engine.drainQueue();
    expect(engine.getRun(second.run.id).state).toBe("shipped");

    const final = completions.at(-1);
    expect(final).toBeDefined();
    expect(final?.shipped).toEqual(["TEZ-1"]);
    expect(final?.failed).toEqual([]);

    const status = engine.getProjectStatus("loom");
    expect(status.shipped).toEqual(["TEZ-1"]);
    expect(status.failed).toEqual([]);
  });
});
