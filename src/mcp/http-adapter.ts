import { requestJson, type LoomHttpClientOptions } from "../cli/http-client.js";

export interface DesignNewPayload {
  slug: string;
  requirementPath?: string;
  requirementText?: string;
  repoRoot?: string;
  redraft?: boolean;
}

export interface DesignExtendPayload {
  slug: string;
  feature: string;
  requirementPath?: string;
  requirementText?: string;
  redraft?: boolean;
}

export interface LoomHttpAdapter {
  health(): Promise<unknown>;
  getQueue(): Promise<unknown>;
  submitRun(projectSlug: string, issueId: string, executionMode?: string): Promise<unknown>;
  submitAdhocRun(project: string, prompt: string): Promise<unknown>;
  getRun(runId: string): Promise<unknown>;
  cancelRun(runId: string): Promise<unknown>;
  retryRun(runId: string): Promise<unknown>;
  cleanupWorkspace(projectSlug: string): Promise<unknown>;
  submitProject(projectSlug: string): Promise<unknown>;
  getProjectStatus(projectSlug: string): Promise<unknown>;
  designNew(payload: DesignNewPayload): Promise<unknown>;
  designExtend(payload: DesignExtendPayload): Promise<unknown>;
  getDesignRun(designRunId: string): Promise<unknown>;
  cancelDesignRun(designRunId: string): Promise<unknown>;
  retryDesignRun(designRunId: string): Promise<unknown>;
  getDesignStatusForProject(slug: string): Promise<unknown>;
}

export function createHttpAdapter(options: LoomHttpClientOptions): LoomHttpAdapter {
  return {
    health: () => requestJson(options, "GET", "/health"),
    getQueue: () => requestJson(options, "GET", "/queue"),
    submitRun: (projectSlug, issueId, executionMode = "enqueue") =>
      requestJson(options, "POST", "/runs", { projectSlug, issueId, executionMode }),
    submitAdhocRun: (project, prompt) =>
      requestJson(options, "POST", "/runs/adhoc", { project, prompt }),
    getRun: (runId) => requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}`),
    cancelRun: (runId) => requestJson(options, "POST", `/runs/${encodeURIComponent(runId)}/cancel`),
    retryRun: (runId) => requestJson(options, "POST", `/runs/${encodeURIComponent(runId)}/retry`),
    cleanupWorkspace: (projectSlug) =>
      requestJson(options, "POST", "/workspace/cleanup", { projectSlug }),
    submitProject: (projectSlug) =>
      requestJson(options, "POST", "/projects/submit", { projectSlug }),
    getProjectStatus: (projectSlug) =>
      requestJson(options, "GET", `/projects/${encodeURIComponent(projectSlug)}/status`),
    designNew: (payload) => requestJson(options, "POST", "/design/new", payload),
    designExtend: (payload) => requestJson(options, "POST", "/design/extend", payload),
    getDesignRun: (id) => requestJson(options, "GET", `/design/${encodeURIComponent(id)}`),
    cancelDesignRun: (id) =>
      requestJson(options, "POST", `/design/${encodeURIComponent(id)}/cancel`),
    retryDesignRun: (id) => requestJson(options, "POST", `/design/${encodeURIComponent(id)}/retry`),
    getDesignStatusForProject: (slug) =>
      requestJson(options, "GET", `/design/projects/${encodeURIComponent(slug)}/status`),
  };
}
