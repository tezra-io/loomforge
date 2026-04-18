import { LinearClient } from "@linear/sdk";

import type { ProjectConfig } from "../config/index.js";
import type { IssueSnapshot, LinearWorkflowClient } from "../workflow/index.js";

export class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearAuthError";
  }
}

export class LinearWorkflowClientImpl implements LinearWorkflowClient {
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

export function createMissingKeyClient(): LinearWorkflowClient {
  return {
    fetchIssue: () => {
      throw new LinearAuthError("Linear API key not configured — add it to ~/.loom/config.yaml");
    },
    updateIssueStatus: () => {
      throw new LinearAuthError("Linear API key not configured — add it to ~/.loom/config.yaml");
    },
  };
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
