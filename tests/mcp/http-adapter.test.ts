import pino from "pino";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createApiServer } from "../../src/api/index.js";
import { createStubWorkflowDependencies } from "../../src/app/index.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";
import { createHttpAdapter } from "../../src/mcp/http-adapter.js";
import type { LoomHttpAdapter } from "../../src/mcp/http-adapter.js";
import { WorkflowEngine } from "../../src/workflow/index.js";
import type { DrainScheduler } from "../../src/app/index.js";
import type { LoomApiServer } from "../../src/api/server.js";

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
    { homeDir: "/Users/test" },
  );
}

let server: LoomApiServer;
let adapter: LoomHttpAdapter;
let engine: WorkflowEngine;
let scheduler: DrainScheduler;

beforeEach(async () => {
  const deps = createStubWorkflowDependencies();
  engine = new WorkflowEngine({
    registry: createRegistry(),
    linear: deps.linear,
    worktrees: deps.worktrees,
    builder: deps.builder,
    reviewer: deps.reviewer,
  });
  scheduler = {
    schedule: () => {},
    drainNow: async () => {
      await engine.drainQueue();
    },
  };
  server = createApiServer({
    engine,
    scheduler,
    logger: pino({ level: "silent" }),
  });
  await server.listen({ port: 0 });
  const addresses = server.addresses();
  const address = addresses[0];
  if (!address) throw new Error("Server did not bind to a port");
  adapter = createHttpAdapter({ baseUrl: `http://127.0.0.1:${address.port}` });
});

afterEach(async () => {
  await server.close();
});

describe("HTTP adapter integration", () => {
  it("health returns daemon status", async () => {
    const result = (await adapter.health()) as { status: string; queueDepth: number };
    expect(result.status).toBe("ok");
    expect(result.queueDepth).toBe(0);
  });

  it("getQueue returns empty queue", async () => {
    const result = (await adapter.getQueue()) as { data: unknown[] };
    expect(result.data).toEqual([]);
  });

  it("submitRun creates a queued run", async () => {
    const result = (await adapter.submitRun("loom", "TEZ-1")) as {
      run: { id: string; state: string };
      queuePosition: number;
    };
    expect(result.run.state).toBe("queued");
    expect(result.queuePosition).toBe(1);
  });

  it("getRun retrieves a run by ID", async () => {
    const submitted = (await adapter.submitRun("loom", "TEZ-1")) as {
      run: { id: string };
    };
    const result = (await adapter.getRun(submitted.run.id)) as {
      run: { id: string; state: string };
    };
    expect(result.run.id).toBe(submitted.run.id);
    expect(result.run.state).toBe("queued");
  });

  it("cancelRun cancels a queued run", async () => {
    const submitted = (await adapter.submitRun("loom", "TEZ-1")) as {
      run: { id: string };
    };
    const result = (await adapter.cancelRun(submitted.run.id)) as {
      run: { id: string; state: string };
    };
    expect(result.run.state).toBe("cancelled");
  });

  it("retryRun throws for a queued run", async () => {
    const submitted = (await adapter.submitRun("loom", "TEZ-1")) as {
      run: { id: string };
    };
    await expect(adapter.retryRun(submitted.run.id)).rejects.toThrow();
  });

  it("cleanupWorkspace succeeds with stub workspace manager", async () => {
    const result = (await adapter.cleanupWorkspace("loom")) as {
      outcome: string;
      summary: string;
    };
    expect(result.outcome).toBe("success");
  });

  it("getRun throws for nonexistent run", async () => {
    await expect(adapter.getRun("nonexistent")).rejects.toThrow();
  });

  it("cleanupWorkspace throws for unknown project", async () => {
    await expect(adapter.cleanupWorkspace("unknown")).rejects.toThrow();
  });
});
