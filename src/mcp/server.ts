import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { VERSION } from "../index.js";
import type { LoomHttpAdapter } from "./http-adapter.js";

export function createMcpServer(adapter: LoomHttpAdapter): McpServer {
  const mcp = new McpServer({ name: "loom", version: VERSION }, { capabilities: { tools: {} } });

  mcp.tool("loom_health", "Check daemon health and queue depth", async () => {
    return safeCall(() => adapter.health());
  });

  mcp.tool("loom_get_queue", "List all queued runs", async () => {
    return safeCall(() => adapter.getQueue());
  });

  mcp.tool(
    "loom_submit_run",
    "Submit a Linear issue for execution",
    {
      projectSlug: z.string().min(1).describe("Project slug from loom config"),
      issueId: z.string().min(1).describe("Linear issue identifier (e.g. TEZ-42)"),
      executionMode: z
        .enum(["run_now_if_idle", "enqueue"])
        .default("enqueue")
        .describe("Execution mode"),
    },
    async ({ projectSlug, issueId, executionMode }) => {
      return safeCall(() => adapter.submitRun(projectSlug, issueId, executionMode));
    },
  );

  mcp.tool(
    "loom_get_run",
    "Get current state of a run by ID",
    { runId: z.string().min(1).describe("Run ID") },
    async ({ runId }) => {
      return safeCall(() => adapter.getRun(runId));
    },
  );

  mcp.tool(
    "loom_cancel_run",
    "Cancel a queued or active run",
    { runId: z.string().min(1).describe("Run ID to cancel") },
    async ({ runId }) => {
      return safeCall(() => adapter.cancelRun(runId));
    },
  );

  mcp.tool(
    "loom_retry_run",
    "Retry a failed or blocked run",
    { runId: z.string().min(1).describe("Run ID to retry") },
    async ({ runId }) => {
      return safeCall(() => adapter.retryRun(runId));
    },
  );

  mcp.tool(
    "loom_cleanup_workspace",
    "Reset project workspace to clean state on the default branch",
    { projectSlug: z.string().min(1).describe("Project slug from loom config") },
    async ({ projectSlug }) => {
      return safeCall(() => adapter.cleanupWorkspace(projectSlug));
    },
  );

  return mcp;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function safeCall(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err: unknown) {
    const payload = normalizeError(err);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
}

function normalizeError(err: unknown): { error: string; details: string | null } {
  if (!(err instanceof Error)) {
    return { error: String(err), details: null };
  }
  try {
    const parsed = JSON.parse(err.message) as unknown;
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      return { error: (parsed as { error: string }).error, details: err.message };
    }
  } catch {
    // not JSON — use raw message
  }
  return { error: err.message, details: null };
}
