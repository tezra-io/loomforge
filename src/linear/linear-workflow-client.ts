import { LinearClient } from "@linear/sdk";

import type { ProjectConfig } from "../config/index.js";
import type { IssueSnapshot, LinearIssueSummary, LinearWorkflowClient } from "../workflow/index.js";
import type {
  LinearAdhocClient,
  LinearAdhocCreateIssueInput,
  LinearAdhocIssueResult,
  LinearLabelSummary,
  LinearStateSummary,
} from "./issue-create.js";

export class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearAuthError";
  }
}

export interface LinearProjectSummary {
  id: string;
  name: string;
  url: string;
  archivedAt: Date | null;
}

export interface LinearDocumentSummary {
  id: string;
  title: string;
  url: string;
}

export interface LinearDesignClient {
  findProjectById(id: string): Promise<LinearProjectSummary | null>;
  findProjectsByName(teamKey: string, name: string): Promise<LinearProjectSummary[]>;
  createProject(
    teamKey: string,
    name: string,
    content: string | null,
  ): Promise<LinearProjectSummary>;
  findDocumentOnProject(projectId: string, title: string): Promise<LinearDocumentSummary | null>;
  findDocumentById(id: string): Promise<LinearDocumentSummary | null>;
  createDocumentOnProject(
    projectId: string,
    title: string,
    content: string,
  ): Promise<LinearDocumentSummary>;
  updateDocument(id: string, content: string): Promise<LinearDocumentSummary>;
}

export class LinearWorkflowClientImpl
  implements LinearWorkflowClient, LinearDesignClient, LinearAdhocClient
{
  private readonly client: LinearClient;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async fetchIssue(_project: ProjectConfig, issueId: string): Promise<IssueSnapshot> {
    return this.safeRequest(async () => {
      const { teamKey, issueNumber } = parseIssueIdentifier(issueId);

      const connection = await this.client.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { eq: issueNumber },
        },
      });

      const issue = connection.nodes[0];
      if (!issue) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      const [labels, comments] = await Promise.all([issue.labels(), issue.comments()]);

      return {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        acceptanceCriteria: extractAcceptanceCriteria(issue.description),
        labels: labels.nodes.map((l) => l.name),
        comments: comments.nodes.map((c) => c.body),
        priority: issue.priorityLabel,
      };
    });
  }

  async listProjectIssues(project: ProjectConfig): Promise<LinearIssueSummary[]> {
    const teamKey = project.linearTeamKey;
    if (!teamKey) {
      throw new Error(
        `Project "${project.slug}" has no linearTeamKey configured — ` +
          "add it to loom.yaml to use project-level submission",
      );
    }

    return this.safeRequest(async () => {
      const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      if (!team) {
        throw new Error(`Linear team not found: ${teamKey}`);
      }

      const states = await team.states();
      const todoStates = states.nodes.filter((s) => s.type === "unstarted" || s.type === "started");
      const todoStateIds = todoStates.map((s) => s.id);

      if (todoStateIds.length === 0) {
        return [];
      }

      const issueFilter: Record<string, unknown> = {
        team: { key: { eq: teamKey } },
        state: { id: { in: todoStateIds } },
      };
      if (project.linearProjectName) {
        issueFilter.project = { name: { eq: project.linearProjectName } };
      }

      const issues: LinearIssueSummary[] = [];
      let connection = await this.client.issues({ filter: issueFilter });

      while (true) {
        for (const issue of connection.nodes) {
          issues.push({
            identifier: issue.identifier,
            title: issue.title,
            priority: issue.priority,
            number: issue.number,
          });
        }

        if (!connection.pageInfo.hasNextPage) break;
        connection = await connection.fetchNext();
      }

      issues.sort((a, b) => {
        const pa = a.priority === 0 ? Infinity : a.priority;
        const pb = b.priority === 0 ? Infinity : b.priority;
        if (pa !== pb) return pa - pb;
        return a.number - b.number;
      });
      return issues;
    });
  }

  async updateIssueStatus(
    _project: ProjectConfig,
    issue: IssueSnapshot,
    statusName: string,
  ): Promise<void> {
    return this.safeRequest(async () => {
      const { teamKey, issueNumber } = parseIssueIdentifier(issue.identifier);

      const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      if (!team) {
        throw new Error(`Linear team not found: ${teamKey}`);
      }

      const states = await team.states();
      const targetState = states.nodes.find((s) => s.name === statusName);
      if (!targetState) {
        throw new Error(`Linear workflow state "${statusName}" not found for team ${teamKey}`);
      }

      const issues = await this.client.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { eq: issueNumber },
        },
      });
      const linearIssue = issues.nodes[0];
      if (!linearIssue) {
        throw new Error(`Issue not found during status update: ${issue.identifier}`);
      }

      await linearIssue.update({ stateId: targetState.id });
    });
  }

  async findProjectById(id: string): Promise<LinearProjectSummary | null> {
    return this.safeRequest(async () => {
      const project = await this.client.project(id).catch(() => null);
      if (!project) return null;
      return toProjectSummary(project);
    });
  }

  async findProjectsByName(teamKey: string, name: string): Promise<LinearProjectSummary[]> {
    return this.safeRequest(async () => {
      const team = await this.resolveTeam(teamKey);
      const projects = await team.projects({ filter: { name: { eq: name } } });
      return projects.nodes.map(toProjectSummary);
    });
  }

  async createProject(
    teamKey: string,
    name: string,
    content: string | null,
  ): Promise<LinearProjectSummary> {
    return this.safeRequest(async () => {
      const team = await this.resolveTeam(teamKey);
      const payload = await this.client.createProject({
        name,
        teamIds: [team.id],
        ...(content ? { content } : {}),
      });
      const project = await payload.project;
      if (!project) {
        throw new Error(`Linear createProject returned no project for "${name}"`);
      }
      return toProjectSummary(project);
    });
  }

  async findDocumentOnProject(
    projectId: string,
    title: string,
  ): Promise<LinearDocumentSummary | null> {
    return this.safeRequest(async () => {
      const project = await this.client.project(projectId).catch(() => null);
      if (!project) return null;

      let connection = await project.documents();
      while (true) {
        for (const doc of connection.nodes) {
          if (doc.title === title) {
            return toDocumentSummary(doc);
          }
        }
        if (!connection.pageInfo.hasNextPage) break;
        connection = await connection.fetchNext();
      }
      return null;
    });
  }

  async findDocumentById(id: string): Promise<LinearDocumentSummary | null> {
    return this.safeRequest(async () => {
      const doc = await this.client.document(id).catch(() => null);
      return doc ? toDocumentSummary(doc) : null;
    });
  }

  async createDocumentOnProject(
    projectId: string,
    title: string,
    content: string,
  ): Promise<LinearDocumentSummary> {
    return this.safeRequest(async () => {
      const payload = await this.client.createDocument({ title, content, projectId });
      const doc = await payload.document;
      if (!doc) {
        throw new Error(`Linear createDocument returned no document for "${title}"`);
      }
      return toDocumentSummary(doc);
    });
  }

  async updateDocument(id: string, content: string): Promise<LinearDocumentSummary> {
    return this.safeRequest(async () => {
      const payload = await this.client.updateDocument(id, { content });
      const doc = await payload.document;
      if (!doc) {
        throw new Error(`Linear updateDocument returned no document for id ${id}`);
      }
      return toDocumentSummary(doc);
    });
  }

  async findTeamIdByKey(teamKey: string): Promise<string | null> {
    return this.safeRequest(async () => {
      const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      return team?.id ?? null;
    });
  }

  async findProjectIdByName(teamId: string, name: string): Promise<string | null> {
    return this.safeRequest(async () => {
      const team = await this.client.team(teamId).catch(() => null);
      if (!team) return null;
      const projects = await team.projects({ filter: { name: { eq: name } } });
      return projects.nodes[0]?.id ?? null;
    });
  }

  async findLabel(teamId: string, name: string): Promise<LinearLabelSummary | null> {
    return this.safeRequest(async () => {
      const team = await this.client.team(teamId).catch(() => null);
      if (!team) return null;
      const labels = await team.labels({ filter: { name: { eq: name } } });
      const label = labels.nodes[0];
      return label ? { id: label.id, name: label.name } : null;
    });
  }

  async createLabel(input: { teamId: string; name: string }): Promise<LinearLabelSummary> {
    return this.safeRequest(async () => {
      const payload = await this.client.createIssueLabel({
        teamId: input.teamId,
        name: input.name,
      });
      const label = await payload.issueLabel;
      if (!label) {
        throw new Error(`Linear createIssueLabel returned no label for "${input.name}"`);
      }
      return { id: label.id, name: label.name };
    });
  }

  async findBacklogState(teamId: string, name: string): Promise<LinearStateSummary | null> {
    return this.safeRequest(async () => {
      const team = await this.client.team(teamId).catch(() => null);
      if (!team) return null;
      const states = await team.states();
      const state = states.nodes.find((s) => s.name === name);
      return state ? { id: state.id } : null;
    });
  }

  async createIssue(input: LinearAdhocCreateIssueInput): Promise<LinearAdhocIssueResult> {
    return this.safeRequest(async () => {
      const payload = await this.client.createIssue({
        title: input.title,
        description: input.description,
        teamId: input.teamId,
        projectId: input.projectId,
        stateId: input.stateId,
        labelIds: input.labelIds,
      });
      const issue = await payload.issue;
      if (!issue) {
        throw new Error(`Linear createIssue returned no issue for "${input.title}"`);
      }
      return { identifier: issue.identifier, url: issue.url };
    });
  }

  private async resolveTeam(teamKey: string) {
    const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
    const team = teams.nodes[0];
    if (!team) {
      throw new Error(`Linear team not found: ${teamKey}`);
    }
    return team;
  }

  private async safeRequest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (isAuthError(error)) {
        throw new LinearAuthError("Linear API authentication failed — check your API key");
      }
      throw error;
    }
  }
}

export function createMissingKeyClient(): LinearWorkflowClient &
  LinearDesignClient &
  LinearAdhocClient {
  const err = () => {
    throw new LinearAuthError(
      "Linear API key not configured — add it to ~/.loomforge/config.yaml or set LINEAR_API_KEY",
    );
  };
  return {
    fetchIssue: err,
    listProjectIssues: err,
    updateIssueStatus: err,
    findProjectById: err,
    findProjectsByName: err,
    createProject: err,
    findDocumentOnProject: err,
    findDocumentById: err,
    createDocumentOnProject: err,
    updateDocument: err,
    findTeamIdByKey: err,
    findProjectIdByName: err,
    findLabel: err,
    createLabel: err,
    findBacklogState: err,
    createIssue: err,
  };
}

interface ProjectLike {
  id: string;
  name: string;
  url: string;
  archivedAt?: Date | null;
}

interface DocumentLike {
  id: string;
  title: string;
  url: string;
}

function toProjectSummary(project: ProjectLike): LinearProjectSummary {
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    archivedAt: project.archivedAt ?? null,
  };
}

function toDocumentSummary(doc: DocumentLike): LinearDocumentSummary {
  return { id: doc.id, title: doc.title, url: doc.url };
}

function parseIssueIdentifier(id: string): { teamKey: string; issueNumber: number } {
  const match = /^([A-Za-z]+)-(\d+)$/.exec(id);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid issue identifier format: ${id} (expected TEAM-123)`);
  }
  return { teamKey: match[1], issueNumber: Number(match[2]) };
}

function extractAcceptanceCriteria(description: string | null | undefined): string | null {
  if (!description) {
    return null;
  }
  const marker = /^##\s*acceptance\s*criteria/im;
  const match = marker.exec(description);
  if (!match) {
    return null;
  }
  const rest = description.slice(match.index + match[0].length);
  const nextSection = /^##\s/m.exec(rest);
  const section = nextSection ? rest.slice(0, nextSection.index) : rest;
  return section.trim() || null;
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("invalid api key")
  );
}
