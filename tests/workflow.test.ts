import { describe, expect, it } from "vitest";

import { parseProjectConfigRegistry } from "../src/config/index.js";
import { SqliteRunStore } from "../src/db/index.js";
import { WorkflowEngine } from "../src/workflow/index.js";
import type {
  BuilderResult,
  PrepareWorkspaceResult,
  ReviewResult,
  VerificationResult,
  WorkflowRunStore,
  WorkflowStepContext,
} from "../src/workflow/index.js";

const issue = {
  identifier: "TEZ-1",
  title: "Build workflow engine",
  description: "Implement the core workflow engine.",
  acceptanceCriteria: "Runs build, verify, review, and push.",
  labels: ["loom"],
  comments: [],
  priority: "High",
};

const workspace = {
  path: "/Users/alice/.loom/worktrees/loom",
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

function verificationPass(): VerificationResult {
  return {
    outcome: "pass",
    summary: "verification passed",
    rawLogPath: "/tmp/verify.log",
    commandResults: [
      {
        name: "test",
        command: "pnpm test",
        outcome: "pass",
        rawLogPath: "/tmp/test.log",
      },
    ],
  };
}

function verificationFail(): VerificationResult {
  return {
    outcome: "fail",
    summary: "tests failed",
    rawLogPath: "/tmp/verify-fail.log",
    commandResults: [
      {
        name: "test",
        command: "pnpm test",
        outcome: "fail",
        rawLogPath: "/tmp/test-fail.log",
      },
    ],
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
    verificationResults?: VerificationResult[];
    reviewResults?: ReviewResult[];
  } = {},
) {
  const buildContexts: WorkflowStepContext[] = [];
  const linearUpdates: string[] = [];
  const verificationResults = [...(options.verificationResults ?? [verificationPass()])];
  const reviewResults = [...(options.reviewResults ?? [reviewPass()])];
  let buildCount = 0;

  const engine = new WorkflowEngine({
    registry: createRegistry(options.maxRevisionLoops),
    newId: options.newId ?? createIds(),
    now: createClock(),
    store: options.store,
    linear: {
      fetchIssue: async () => issue,
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
    verifier: {
      verify: async () => verificationResults.shift() ?? verificationPass(),
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
  it("runs the happy path through build, verify, review, push, and Linear Done", async () => {
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

  it("feeds verification failures into a bounded revision attempt", async () => {
    const { buildContexts, engine } = createEngine({
      verificationResults: [verificationFail(), verificationPass()],
    });
    const runId = submitRun(engine);

    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("shipped");
    expect(run.revisionCount).toBe(1);
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts.at(0)?.outcome).toBe("revision_requested");
    expect(buildContexts.at(1)?.revisionInput).toMatchObject({
      source: "verification",
      summary: "tests failed",
    });
  });

  it("blocks when review still requires changes after revision budget is exhausted", async () => {
    const { engine, linearUpdates } = createEngine({
      maxRevisionLoops: 0,
      reviewResults: [reviewRevise()],
    });
    const runId = submitRun(engine);

    await engine.drainQueue();

    const run = engine.getRun(runId);
    expect(run.state).toBe("blocked");
    expect(run.failureReason).toBe("review_loop_exhausted");
    expect(run.handoff).toBeNull();
    expect(linearUpdates.at(-1)).toBe("Blocked");
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
      verifier: { verify: async () => verificationPass() },
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
