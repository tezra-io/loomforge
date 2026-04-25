import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { VERSION } from "../index.js";
import type { LoomHttpAdapter } from "./http-adapter.js";

export function createMcpServer(adapter: LoomHttpAdapter): McpServer {
  const mcp = new McpServer(
    { name: "loomforge", version: VERSION },
    { capabilities: { tools: {} } },
  );

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
    "loom_submit_project",
    "Fetch all actionable issues for a project from Linear and enqueue them",
    {
      projectSlug: z.string().min(1).describe("Project slug from loom config"),
    },
    async ({ projectSlug }) => {
      return safeCall(() => adapter.submitProject(projectSlug));
    },
  );

  mcp.tool(
    "loom_get_project_status",
    "Check whether all runs for a project are complete. Returns done: true when no runs are in progress, with lists of shipped, failed, blocked, and cancelled issue IDs. Also returns pullRequestUrl if a PR was created.",
    {
      projectSlug: z.string().min(1).describe("Project slug from loom config"),
    },
    async ({ projectSlug }) => {
      return safeCall(() => adapter.getProjectStatus(projectSlug));
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

  const slugSchema = z
    .string()
    .regex(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      "must be lowercase, hyphen-separated (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)",
    );

  mcp.tool(
    "loom_design_new_project",
    "Scaffold a new project, draft and review a design doc, publish to Linear, and optionally register it in loom.yaml. Exactly one of requirementPath or requirementText must be provided.",
    {
      slug: slugSchema.describe("Lowercase, hyphen-separated project slug"),
      requirementPath: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path to a requirement file on the daemon machine"),
      requirementText: z
        .string()
        .min(1)
        .optional()
        .describe("Raw markdown text describing the requirement"),
      repoRoot: z
        .string()
        .min(1)
        .optional()
        .describe("Override the default design.repoRoot from config"),
      redraft: z.boolean().optional().describe("Force a fresh draft even if a prior draft exists"),
    },
    async ({ slug, requirementPath, requirementText, repoRoot, redraft }) => {
      return safeCall(() =>
        adapter.designNew({ slug, requirementPath, requirementText, repoRoot, redraft }),
      );
    },
  );

  mcp.tool(
    "loom_design_extend_project",
    "Draft a feature-extension design doc for an existing project and attach it as a new Linear Document.",
    {
      slug: slugSchema.describe("Existing project slug (must be in loom.yaml)"),
      feature: slugSchema.describe("Lowercase, hyphen-separated feature slug"),
      requirementPath: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path to a requirement file on the daemon machine"),
      requirementText: z
        .string()
        .min(1)
        .optional()
        .describe("Raw markdown text describing the feature requirement"),
      redraft: z.boolean().optional().describe("Force a fresh draft"),
    },
    async ({ slug, feature, requirementPath, requirementText, redraft }) => {
      return safeCall(() =>
        adapter.designExtend({ slug, feature, requirementPath, requirementText, redraft }),
      );
    },
  );

  mcp.tool(
    "loom_get_design_run",
    "Fetch current state, findings, and handoff for a design run",
    { designRunId: z.string().min(1).describe("Design run ID") },
    async ({ designRunId }) => safeCall(() => adapter.getDesignRun(designRunId)),
  );

  mcp.tool(
    "loom_cancel_design_run",
    "Cancel a queued or active design run",
    { designRunId: z.string().min(1).describe("Design run ID") },
    async ({ designRunId }) => safeCall(() => adapter.cancelDesignRun(designRunId)),
  );

  mcp.tool(
    "loom_retry_design_run",
    "Retry a failed or stuck design run from its last incomplete step",
    { designRunId: z.string().min(1).describe("Design run ID") },
    async ({ designRunId }) => safeCall(() => adapter.retryDesignRun(designRunId)),
  );

  mcp.tool(
    "loom_get_design_run_status_for_project",
    "Fetch the latest design-run state for a project slug (mirrors loom_get_project_status for the design surface)",
    { slug: slugSchema.describe("Project slug") },
    async ({ slug }) => safeCall(() => adapter.getDesignStatusForProject(slug)),
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
