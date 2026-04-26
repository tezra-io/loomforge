import { isAbsolute, resolve } from "node:path";

import type { ProjectConfig, ProjectConfigRegistry } from "../config/index.js";
import {
  AdhocIssueError,
  createAdhocIssue,
  type AdhocIssueErrorReason,
  type LinearAdhocClient,
} from "../linear/index.js";
import type { SubmitRunInput, SubmitRunResult } from "./types.js";

const PROMPT_MAX_LEN = 8000;
const TITLE_MAX_LEN = 80;
const ADHOC_LABEL = "loomforge-adhoc";
const BACKLOG_STATE_NAME = "Backlog";

export interface AdhocSubmitInput {
  project: string;
  prompt: string;
}

export interface AdhocRunDeps {
  registry: ProjectConfigRegistry;
  linear: LinearAdhocClient;
  engine: { submitRun(input: SubmitRunInput): SubmitRunResult };
  scheduler: { schedule(): void };
  now: () => Date;
}

export type AdhocSubmitResult =
  | {
      ok: true;
      runId: string;
      issueId: string;
      linearUrl: string;
      queuePosition: number;
    }
  | { ok: false; error: "validation_failed"; details: string }
  | { ok: false; error: "project_not_found"; projectIdentifier: string }
  | {
      ok: false;
      error: "linear_not_configured";
      projectSlug: string;
      missing: string[];
    }
  | {
      ok: false;
      error: "linear_create_failed";
      reason: AdhocIssueErrorReason;
      message: string;
    }
  | {
      ok: false;
      error: "submit_after_create_failed";
      orphanedIssueId: string;
      message: string;
    };

export async function submitAdhocRun(
  deps: AdhocRunDeps,
  input: AdhocSubmitInput,
): Promise<AdhocSubmitResult> {
  const promptError = validatePrompt(input.prompt);
  if (promptError) {
    return { ok: false, error: "validation_failed", details: promptError };
  }

  const projectResolution = resolveProject(deps.registry, input.project);
  if (projectResolution.kind === "validation_failed") {
    return { ok: false, error: "validation_failed", details: projectResolution.details };
  }
  if (projectResolution.kind === "not_found") {
    return {
      ok: false,
      error: "project_not_found",
      projectIdentifier: input.project,
    };
  }

  const project = projectResolution.project;
  const missing: string[] = [];
  if (!project.linearTeamKey) missing.push("linearTeamKey");
  if (!project.linearProjectName) missing.push("linearProjectName");
  if (missing.length > 0) {
    return {
      ok: false,
      error: "linear_not_configured",
      projectSlug: project.slug,
      missing,
    };
  }

  const teamKey = project.linearTeamKey;
  const projectName = project.linearProjectName;
  if (!teamKey || !projectName) {
    return {
      ok: false,
      error: "linear_not_configured",
      projectSlug: project.slug,
      missing,
    };
  }

  const title = deriveTitle(input.prompt);
  const description = buildDescription(input.prompt, deps.now());

  let issue: { identifier: string; url: string };
  try {
    issue = await createAdhocIssue(deps.linear, {
      teamKey,
      projectName,
      labelName: ADHOC_LABEL,
      backlogStateName: BACKLOG_STATE_NAME,
      title,
      description,
    });
  } catch (error) {
    if (error instanceof AdhocIssueError) {
      return {
        ok: false,
        error: "linear_create_failed",
        reason: error.reason,
        message: error.message,
      };
    }
    return {
      ok: false,
      error: "linear_create_failed",
      reason: "issue_create_failed",
      message: errorMessage(error),
    };
  }

  let result: SubmitRunResult;
  try {
    result = deps.engine.submitRun({
      projectSlug: project.slug,
      issueId: issue.identifier,
      executionMode: "enqueue",
      source: "adhoc",
    });
  } catch (error) {
    return {
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: issue.identifier,
      message: errorMessage(error),
    };
  }

  if (!result.accepted) {
    return {
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: issue.identifier,
      message: `submitRun rejected: ${result.reason}`,
    };
  }

  deps.scheduler.schedule();

  return {
    ok: true,
    runId: result.run.id,
    issueId: issue.identifier,
    linearUrl: issue.url,
    queuePosition: result.queuePosition,
  };
}

function validatePrompt(prompt: string): string | null {
  if (typeof prompt !== "string") return "prompt must be a string";
  if (prompt.trim().length === 0) return "prompt must not be empty or whitespace-only";
  if (prompt.length > PROMPT_MAX_LEN) {
    return `prompt exceeds ${PROMPT_MAX_LEN}-character limit`;
  }
  return null;
}

type ProjectResolution =
  | { kind: "ok"; project: ProjectConfig }
  | { kind: "not_found" }
  | { kind: "validation_failed"; details: string };

function resolveProject(registry: ProjectConfigRegistry, identifier: string): ProjectResolution {
  if (identifier.length === 0) {
    return { kind: "validation_failed", details: "project must not be empty" };
  }

  const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (slugPattern.test(identifier)) {
    const project = registry.bySlug.get(identifier);
    return project ? { kind: "ok", project } : { kind: "not_found" };
  }

  if (!isAbsolute(identifier)) {
    return {
      kind: "validation_failed",
      details: "project must be a slug or an absolute path",
    };
  }

  const target = resolve(identifier);
  for (const project of registry.projects) {
    if (resolve(project.repoRoot) === target) {
      return { kind: "ok", project };
    }
  }
  return { kind: "not_found" };
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const source = firstLine ?? prompt.trim();
  return source.length > TITLE_MAX_LEN ? source.slice(0, TITLE_MAX_LEN) : source;
}

function buildDescription(prompt: string, now: Date): string {
  const datePart = now.toISOString().slice(0, 10);
  return `${prompt}\n\n_Submitted via Loomforge ad-hoc on ${datePart}._`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
