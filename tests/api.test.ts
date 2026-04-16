import pino from "pino";
import { describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/index.js";
import { createStubWorkflowDependencies } from "../src/app/index.js";
import { parseProjectConfigRegistry } from "../src/config/index.js";
import { WorkflowEngine } from "../src/workflow/index.js";
import type { DrainScheduler } from "../src/app/index.js";

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
`,
    { homeDir: "/Users/alice" },
  );
}

function createTestServer() {
  let scheduled = 0;
  const dependencies = createStubWorkflowDependencies();
  const engine = new WorkflowEngine({
    registry: createRegistry(),
    linear: dependencies.linear,
    worktrees: dependencies.worktrees,
    builder: dependencies.builder,
    verifier: dependencies.verifier,
    reviewer: dependencies.reviewer,
  });
  const scheduler: DrainScheduler = {
    schedule: () => {
      scheduled += 1;
    },
    drainNow: async () => {
      await engine.drainQueue();
    },
  };
  const server = createApiServer({
    engine,
    scheduler,
    logger: pino({ level: "silent" }),
  });

  return {
    engine,
    getScheduledCount: () => scheduled,
    scheduler,
    server,
  };
}

describe("api server", () => {
  it("accepts a run, schedules draining, and exposes run state", async () => {
    const { getScheduledCount, scheduler, server } = createTestServer();

    try {
      const submitted = await server.inject({
        method: "POST",
        url: "/runs",
        payload: {
          projectSlug: "loom",
          issueId: "TEZ-1",
          executionMode: "enqueue",
        },
      });
      const body = submitted.json<{ run: { id: string; state: string }; queuePosition: number }>();

      expect(submitted.statusCode).toBe(202);
      expect(body).toMatchObject({
        run: {
          state: "queued",
        },
        queuePosition: 1,
      });
      expect(getScheduledCount()).toBe(1);

      await scheduler.drainNow();

      const fetched = await server.inject({
        method: "GET",
        url: `/runs/${body.run.id}`,
      });

      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toMatchObject({
        run: {
          id: body.run.id,
          state: "shipped",
          handoff: {
            version: 1,
            recommendedNextAction: "merge",
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns busy for run_now_if_idle when a run is queued", async () => {
    const { server } = createTestServer();

    try {
      await server.inject({
        method: "POST",
        url: "/runs",
        payload: {
          projectSlug: "loom",
          issueId: "TEZ-1",
          executionMode: "enqueue",
        },
      });
      const rejected = await server.inject({
        method: "POST",
        url: "/runs",
        payload: {
          projectSlug: "loom",
          issueId: "TEZ-2",
          executionMode: "run_now_if_idle",
        },
      });

      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({
        accepted: false,
        reason: "busy",
      });
    } finally {
      await server.close();
    }
  });

  it("cancels queued runs", async () => {
    const { server } = createTestServer();

    try {
      const submitted = await server.inject({
        method: "POST",
        url: "/runs",
        payload: {
          projectSlug: "loom",
          issueId: "TEZ-1",
          executionMode: "enqueue",
        },
      });
      const runId = submitted.json<{ run: { id: string } }>().run.id;
      const cancelled = await server.inject({
        method: "POST",
        url: `/runs/${runId}/cancel`,
      });

      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        run: {
          id: runId,
          state: "cancelled",
          failureReason: "operator_cancel",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("reports health and queue state", async () => {
    const { server } = createTestServer();

    try {
      const health = await server.inject({ method: "GET", url: "/health" });
      const queue = await server.inject({ method: "GET", url: "/queue" });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok", queueDepth: 0 });
      expect(queue.statusCode).toBe(200);
      expect(queue.json()).toEqual({ data: [] });
    } finally {
      await server.close();
    }
  });
});
