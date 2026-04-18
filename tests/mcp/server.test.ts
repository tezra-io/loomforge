import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createMcpServer } from "../../src/mcp/server.js";
import type { LoomHttpAdapter } from "../../src/mcp/http-adapter.js";

function stubAdapter(overrides: Partial<LoomHttpAdapter> = {}): LoomHttpAdapter {
  return {
    health: async () => ({ status: "ok", queueDepth: 0 }),
    getQueue: async () => ({ data: [] }),
    submitRun: async () => ({
      run: { id: "run-1", state: "queued" },
      queuePosition: 1,
    }),
    getRun: async () => ({ run: { id: "run-1", state: "shipped" } }),
    cancelRun: async () => ({ run: { id: "run-1", state: "cancelled" } }),
    cleanupWorkspace: async () => ({ outcome: "success", summary: "Workspace cleaned" }),
    ...overrides,
  };
}

let client: Client;
let cleanup: () => Promise<void>;

async function setup(adapter: LoomHttpAdapter) {
  const mcp = createMcpServer(adapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await c.connect(clientTransport);
  client = c;
  cleanup = async () => {
    await c.close();
    await mcp.close();
  };
}

afterEach(async () => {
  if (cleanup) await cleanup();
});

describe("MCP server tools", () => {
  beforeEach(async () => {
    await setup(stubAdapter());
  });

  it("lists all registered tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "loom_cancel_run",
      "loom_cleanup_workspace",
      "loom_get_queue",
      "loom_get_run",
      "loom_health",
      "loom_submit_run",
    ]);
  });

  it("loom_health returns daemon status", async () => {
    const result = await client.callTool({ name: "loom_health", arguments: {} });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toEqual({ status: "ok", queueDepth: 0 });
  });

  it("loom_get_queue returns queue data", async () => {
    const result = await client.callTool({ name: "loom_get_queue", arguments: {} });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toEqual({ data: [] });
  });

  it("loom_submit_run passes arguments to adapter", async () => {
    let captured: { projectSlug: string; issueId: string; executionMode: string } | null = null;
    await cleanup();
    await setup(
      stubAdapter({
        submitRun: async (projectSlug, issueId, executionMode) => {
          captured = {
            projectSlug,
            issueId,
            executionMode: executionMode ?? "enqueue",
          };
          return { run: { id: "run-2", state: "queued" }, queuePosition: 1 };
        },
      }),
    );

    const result = await client.callTool({
      name: "loom_submit_run",
      arguments: {
        projectSlug: "loom",
        issueId: "TEZ-42",
        executionMode: "run_now_if_idle",
      },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.run.id).toBe("run-2");
    expect(captured).toEqual({
      projectSlug: "loom",
      issueId: "TEZ-42",
      executionMode: "run_now_if_idle",
    });
  });

  it("loom_get_run returns run state", async () => {
    const result = await client.callTool({
      name: "loom_get_run",
      arguments: { runId: "run-1" },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.run.state).toBe("shipped");
  });

  it("loom_cancel_run cancels a run", async () => {
    const result = await client.callTool({
      name: "loom_cancel_run",
      arguments: { runId: "run-1" },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.run.state).toBe("cancelled");
  });

  it("loom_cleanup_workspace cleans workspace", async () => {
    const result = await client.callTool({
      name: "loom_cleanup_workspace",
      arguments: { projectSlug: "loom" },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.outcome).toBe("success");
  });
});

describe("MCP server input validation", () => {
  beforeEach(async () => {
    await setup(stubAdapter());
  });

  it("rejects loom_submit_run with missing projectSlug", async () => {
    const result = await client.callTool({
      name: "loom_submit_run",
      arguments: { issueId: "TEZ-1" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects loom_get_run with missing runId", async () => {
    const result = await client.callTool({
      name: "loom_get_run",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("rejects loom_cleanup_workspace with missing projectSlug", async () => {
    const result = await client.callTool({
      name: "loom_cleanup_workspace",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});

describe("MCP server error handling", () => {
  it("returns structured error when adapter throws", async () => {
    await setup(
      stubAdapter({
        health: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    const result = await client.callTool({ name: "loom_health", arguments: {} });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe("connection refused");
  });

  it("normalizes HTTP error JSON into error envelope", async () => {
    await setup(
      stubAdapter({
        getRun: async () => {
          throw new Error(JSON.stringify({ error: "run_not_found" }));
        },
      }),
    );

    const result = await client.callTool({
      name: "loom_get_run",
      arguments: { runId: "missing" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe("run_not_found");
  });
});
