import { requestJson, type LoomHttpClientOptions } from "../cli/http-client.js";

export interface LoomHttpAdapter {
  health(): Promise<unknown>;
  getQueue(): Promise<unknown>;
  submitRun(projectSlug: string, issueId: string, executionMode?: string): Promise<unknown>;
  getRun(runId: string): Promise<unknown>;
  cancelRun(runId: string): Promise<unknown>;
  retryRun(runId: string): Promise<unknown>;
  cleanupWorkspace(projectSlug: string): Promise<unknown>;
}

export function createHttpAdapter(options: LoomHttpClientOptions): LoomHttpAdapter {
  return {
    health: () => requestJson(options, "GET", "/health"),
    getQueue: () => requestJson(options, "GET", "/queue"),
    submitRun: (projectSlug, issueId, executionMode = "enqueue") =>
      requestJson(options, "POST", "/runs", { projectSlug, issueId, executionMode }),
    getRun: (runId) => requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}`),
    cancelRun: (runId) => requestJson(options, "POST", `/runs/${encodeURIComponent(runId)}/cancel`),
    retryRun: (runId) => requestJson(options, "POST", `/runs/${encodeURIComponent(runId)}/retry`),
    cleanupWorkspace: (projectSlug) =>
      requestJson(options, "POST", "/workspace/cleanup", { projectSlug }),
  };
}
