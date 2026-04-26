export interface LinearLabelSummary {
  id: string;
  name: string;
}

export interface LinearStateSummary {
  id: string;
}

export interface LinearAdhocIssueResult {
  identifier: string;
  url: string;
}

export interface LinearAdhocCreateIssueInput {
  title: string;
  description: string;
  teamId: string;
  projectId: string;
  stateId: string;
  labelIds: string[];
}

export interface LinearAdhocClient {
  findTeamIdByKey(teamKey: string): Promise<string | null>;
  findProjectIdByName(teamId: string, name: string): Promise<string | null>;
  findLabel(teamId: string, name: string): Promise<LinearLabelSummary | null>;
  createLabel(input: { teamId: string; name: string }): Promise<LinearLabelSummary>;
  findBacklogState(teamId: string, name: string): Promise<LinearStateSummary | null>;
  createIssue(input: LinearAdhocCreateIssueInput): Promise<LinearAdhocIssueResult>;
}

export interface AdhocIssueParams {
  teamKey: string;
  projectName: string;
  labelName: string;
  backlogStateName: string;
  title: string;
  description: string;
}

export type AdhocIssueErrorReason =
  | "missing_team"
  | "missing_project"
  | "missing_backlog_state"
  | "label_setup_failed"
  | "issue_create_failed";

export class AdhocIssueError extends Error {
  readonly reason: AdhocIssueErrorReason;

  constructor(reason: AdhocIssueErrorReason, detail: string, options?: { cause?: unknown }) {
    super(`${reason}: ${detail}`, options);
    this.name = "AdhocIssueError";
    this.reason = reason;
  }
}

export async function createAdhocIssue(
  client: LinearAdhocClient,
  params: AdhocIssueParams,
): Promise<LinearAdhocIssueResult> {
  const teamId = await client.findTeamIdByKey(params.teamKey);
  if (!teamId) {
    throw new AdhocIssueError("missing_team", `Linear team not found for key "${params.teamKey}"`);
  }

  const projectId = await client.findProjectIdByName(teamId, params.projectName);
  if (!projectId) {
    throw new AdhocIssueError(
      "missing_project",
      `Linear project not found by name "${params.projectName}" on team "${params.teamKey}"`,
    );
  }

  const stateId = await resolveBacklogState(client, teamId, params.backlogStateName);
  const labelId = await resolveLabel(client, teamId, params.labelName);

  try {
    return await client.createIssue({
      title: params.title,
      description: params.description,
      teamId,
      projectId,
      stateId: stateId.id,
      labelIds: [labelId.id],
    });
  } catch (cause) {
    throw new AdhocIssueError(
      "issue_create_failed",
      `Linear issueCreate failed: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

async function resolveBacklogState(
  client: LinearAdhocClient,
  teamId: string,
  name: string,
): Promise<LinearStateSummary> {
  const state = await client.findBacklogState(teamId, name);
  if (!state) {
    throw new AdhocIssueError(
      "missing_backlog_state",
      `Linear workflow state "${name}" not found on team`,
    );
  }
  return state;
}

async function resolveLabel(
  client: LinearAdhocClient,
  teamId: string,
  name: string,
): Promise<LinearLabelSummary> {
  const existing = await client.findLabel(teamId, name);
  if (existing) {
    return existing;
  }

  try {
    return await client.createLabel({ teamId, name });
  } catch (createError) {
    const second = await client.findLabel(teamId, name);
    if (second) {
      return second;
    }
    throw new AdhocIssueError(
      "label_setup_failed",
      `Failed to ensure Linear label "${name}": ${errorMessage(createError)}`,
      { cause: createError },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
