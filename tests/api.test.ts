import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createApiServer } from "../src/api/index.js";
import { createStubWorkflowDependencies } from "../src/app/index.js";
import { ArtifactStore } from "../src/artifacts/index.js";
import { parseProjectConfigRegistry } from "../src/config/index.js";
import { SqliteRunStore } from "../src/db/index.js";
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

function createTestServer(options?: {
  store?: SqliteRunStore;
  artifactStore?: ArtifactStore;
  blockWorkspace?: boolean;
}) {
  let scheduled = 0;
  const dependencies = createStubWorkflowDependencies();
  const worktrees = options?.blockWorkspace
    ? {
        ...dependencies.worktrees,
        prepareWorkspace: async () =>
          ({
            outcome: "blocked" as const,
            reason: "dirty_workspace" as const,
            summary: "workspace dirty",
          }) as const,
      }
    : dependencies.worktrees;
  const engine = new WorkflowEngine({
    registry: createRegistry(),
    store: options?.store,
    artifacts: options?.artifactStore,
    linear: dependencies.linear,
    worktrees,
    builder: dependencies.builder,
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
    store: options?.store,
    artifactStore: options?.artifactStore,
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

  it("retries a blocked run and schedules draining", async () => {
    const { getScheduledCount, scheduler, server } = createTestServer({ blockWorkspace: true });

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
      await scheduler.drainNow();

      const fetched = await server.inject({ method: "GET", url: `/runs/${runId}` });
      expect(fetched.json<{ run: { state: string } }>().run.state).toBe("blocked");

      const retried = await server.inject({
        method: "POST",
        url: `/runs/${runId}/retry`,
      });

      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({
        run: { id: runId, state: "queued" },
      });
      expect(getScheduledCount()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("returns 409 when retrying a non-terminal run", async () => {
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
      const retried = await server.inject({
        method: "POST",
        url: `/runs/${runId}/retry`,
      });

      expect(retried.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("returns 404 when retrying a nonexistent run", async () => {
    const { server } = createTestServer();

    try {
      const retried = await server.inject({
        method: "POST",
        url: "/runs/nonexistent/retry",
      });
      expect(retried.statusCode).toBe(404);
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

describe("artifact and log endpoints", () => {
  let tmpDir: string;
  let store: SqliteRunStore;
  let artifactStore: ArtifactStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "loom-api-artifacts-"));
    store = SqliteRunStore.open(":memory:");
    artifactStore = new ArtifactStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lists artifacts for a shipped run", async () => {
    const { scheduler, server } = createTestServer({ store, artifactStore });

    try {
      const submitted = await server.inject({
        method: "POST",
        url: "/runs",
        payload: { projectSlug: "loom", issueId: "TEZ-1" },
      });
      const runId = submitted.json<{ run: { id: string } }>().run.id;
      await scheduler.drainNow();

      const response = await server.inject({
        method: "GET",
        url: `/runs/${runId}/artifacts`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ artifacts: Array<{ kind: string; path: string }> }>();
      expect(body.artifacts.length).toBeGreaterThanOrEqual(2);

      const kinds = body.artifacts.map((a) => a.kind);
      expect(kinds).toContain("issue_snapshot");
      expect(kinds).toContain("handoff");
    } finally {
      await server.close();
    }
  });

  it("returns logs content for a shipped run", async () => {
    const { scheduler, server } = createTestServer({ store, artifactStore });

    try {
      const submitted = await server.inject({
        method: "POST",
        url: "/runs",
        payload: { projectSlug: "loom", issueId: "TEZ-1" },
      });
      const runId = submitted.json<{ run: { id: string } }>().run.id;
      await scheduler.drainNow();

      const response = await server.inject({
        method: "GET",
        url: `/runs/${runId}/logs`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        logs: Array<{ id: string; kind: string; content: string }>;
      }>();
      expect(body.logs.length).toBeGreaterThanOrEqual(1);

      const snapshotLog = body.logs.find((l) => l.kind === "issue_snapshot");
      expect(snapshotLog).toBeDefined();
      const parsed = JSON.parse(snapshotLog?.content ?? "{}");
      expect(parsed.identifier).toBe("TEZ-1");
    } finally {
      await server.close();
    }
  });

  it("returns 404 for artifacts of nonexistent run", async () => {
    const { server } = createTestServer({ store, artifactStore });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/runs/nonexistent/artifacts",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns empty artifacts for a run with no artifacts", async () => {
    const { server } = createTestServer({ store, artifactStore });

    try {
      const submitted = await server.inject({
        method: "POST",
        url: "/runs",
        payload: { projectSlug: "loom", issueId: "TEZ-1" },
      });
      const runId = submitted.json<{ run: { id: string } }>().run.id;

      const response = await server.inject({
        method: "GET",
        url: `/runs/${runId}/artifacts`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ artifacts: [] });
    } finally {
      await server.close();
    }
  });
});
