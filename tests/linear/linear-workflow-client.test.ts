import { describe, it, expect, vi } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import {
  LinearAuthError,
  LinearWorkflowClientImpl,
  createMissingKeyClient,
} from "../../src/linear/index.js";

vi.mock("@linear/sdk", () => {
  return {
    LinearClient: vi.fn(),
  };
});

import { LinearClient } from "@linear/sdk";

const MockLinearClient = vi.mocked(LinearClient);

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug: "test",
    repoRoot: "/repos/test",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/data/test",
    verification: { commands: [{ name: "test", command: "echo ok", timeoutMs: 10_000 }] },
    timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
    review: { maxRevisionLoops: 3, blockingSeverities: ["P0", "P1"] },
    linearStatuses: {
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      blocked: "Blocked",
    },
    ...overrides,
  };
}

function makeMockIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-uuid-1",
    identifier: "TEZ-42",
    title: "Fix the widget",
    description: "Something is broken.\n\n## Acceptance Criteria\n\n- It works\n- No errors",
    priority: 2,
    priorityLabel: "High",
    labels: () =>
      Promise.resolve({
        nodes: [{ name: "bug" }, { name: "urgent" }],
      }),
    comments: () =>
      Promise.resolve({
        nodes: [{ body: "Please fix ASAP" }, { body: "Confirmed on staging" }],
      }),
    update: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function setupMockClient(mockIssues: unknown[] = [makeMockIssue()]) {
  const mockClient = {
    issues: vi.fn().mockResolvedValue({ nodes: mockIssues }),
    teams: vi.fn().mockResolvedValue({ nodes: [] }),
  };
  MockLinearClient.mockImplementation(function () {
    return mockClient as unknown as InstanceType<typeof LinearClient>;
  });
  return mockClient;
}

describe("LinearWorkflowClientImpl", () => {
  describe("fetchIssue", () => {
    it("fetches and maps an issue to IssueSnapshot", async () => {
      setupMockClient();
      const client = new LinearWorkflowClientImpl("test-api-key");
      const project = makeProject();

      const snapshot = await client.fetchIssue(project, "TEZ-42");

      expect(snapshot.identifier).toBe("TEZ-42");
      expect(snapshot.title).toBe("Fix the widget");
      expect(snapshot.description).toContain("Something is broken");
      expect(snapshot.acceptanceCriteria).toBe("- It works\n- No errors");
      expect(snapshot.labels).toEqual(["bug", "urgent"]);
      expect(snapshot.comments).toEqual(["Please fix ASAP", "Confirmed on staging"]);
      expect(snapshot.priority).toBe("High");
    });

    it("passes the correct filter to the SDK", async () => {
      const mockClient = setupMockClient();
      const client = new LinearWorkflowClientImpl("test-api-key");

      await client.fetchIssue(makeProject(), "ABC-7");

      expect(mockClient.issues).toHaveBeenCalledWith({
        filter: {
          team: { key: { eq: "ABC" } },
          number: { eq: 7 },
        },
      });
    });

    it("throws when the issue is not found", async () => {
      setupMockClient([]);
      const client = new LinearWorkflowClientImpl("test-api-key");

      await expect(client.fetchIssue(makeProject(), "TEZ-999")).rejects.toThrow(
        "Issue not found: TEZ-999",
      );
    });

    it("throws LinearAuthError on authentication failure", async () => {
      const mockClient = {
        issues: vi.fn().mockRejectedValue(new Error("Authentication failed")),
        teams: vi.fn(),
      };
      MockLinearClient.mockImplementation(function () {
        return mockClient as unknown as InstanceType<typeof LinearClient>;
      });
      const client = new LinearWorkflowClientImpl("bad-key");

      await expect(client.fetchIssue(makeProject(), "TEZ-1")).rejects.toThrow(LinearAuthError);
    });

    it("returns null acceptanceCriteria when no AC section exists", async () => {
      setupMockClient([makeMockIssue({ description: "Just a plain description" })]);
      const client = new LinearWorkflowClientImpl("test-api-key");

      const snapshot = await client.fetchIssue(makeProject(), "TEZ-42");

      expect(snapshot.acceptanceCriteria).toBeNull();
    });

    it("returns null description and acceptanceCriteria when description is null", async () => {
      setupMockClient([makeMockIssue({ description: null })]);
      const client = new LinearWorkflowClientImpl("test-api-key");

      const snapshot = await client.fetchIssue(makeProject(), "TEZ-42");

      expect(snapshot.description).toBeNull();
      expect(snapshot.acceptanceCriteria).toBeNull();
    });

    it("throws LinearAuthError when labels() rejects with auth error", async () => {
      setupMockClient([
        makeMockIssue({
          labels: () => Promise.reject(new Error("401 Unauthorized")),
        }),
      ]);
      const client = new LinearWorkflowClientImpl("test-api-key");

      await expect(client.fetchIssue(makeProject(), "TEZ-42")).rejects.toThrow(LinearAuthError);
    });

    it("throws on invalid issue identifier format", async () => {
      setupMockClient();
      const client = new LinearWorkflowClientImpl("test-api-key");

      await expect(client.fetchIssue(makeProject(), "bad-format")).rejects.toThrow(
        "Invalid issue identifier format",
      );
    });
  });

  describe("updateIssueStatus", () => {
    it("updates the issue state via the SDK", async () => {
      const mockIssue = makeMockIssue();
      const mockClient = {
        issues: vi.fn().mockResolvedValue({ nodes: [mockIssue] }),
        teams: vi.fn().mockResolvedValue({
          nodes: [
            {
              id: "team-1",
              states: () =>
                Promise.resolve({
                  nodes: [
                    { id: "state-1", name: "In Progress" },
                    { id: "state-2", name: "Done" },
                  ],
                }),
            },
          ],
        }),
      };
      MockLinearClient.mockImplementation(function () {
        return mockClient as unknown as InstanceType<typeof LinearClient>;
      });
      const client = new LinearWorkflowClientImpl("test-api-key");
      const issue = {
        identifier: "TEZ-42",
        title: "",
        description: null,
        acceptanceCriteria: null,
        labels: [],
        comments: [],
        priority: null,
      };

      await client.updateIssueStatus(makeProject(), issue, "Done");

      expect(mockIssue.update).toHaveBeenCalledWith({ stateId: "state-2" });
    });

    it("throws when team is not found", async () => {
      const mockClient = {
        issues: vi.fn(),
        teams: vi.fn().mockResolvedValue({ nodes: [] }),
      };
      MockLinearClient.mockImplementation(function () {
        return mockClient as unknown as InstanceType<typeof LinearClient>;
      });
      const client = new LinearWorkflowClientImpl("test-api-key");
      const issue = {
        identifier: "TEZ-42",
        title: "",
        description: null,
        acceptanceCriteria: null,
        labels: [],
        comments: [],
        priority: null,
      };

      await expect(client.updateIssueStatus(makeProject(), issue, "Done")).rejects.toThrow(
        "Linear team not found: TEZ",
      );
    });

    it("throws when target state is not found", async () => {
      const mockClient = {
        issues: vi.fn(),
        teams: vi.fn().mockResolvedValue({
          nodes: [
            {
              id: "team-1",
              states: () =>
                Promise.resolve({
                  nodes: [{ id: "state-1", name: "In Progress" }],
                }),
            },
          ],
        }),
      };
      MockLinearClient.mockImplementation(function () {
        return mockClient as unknown as InstanceType<typeof LinearClient>;
      });
      const client = new LinearWorkflowClientImpl("test-api-key");
      const issue = {
        identifier: "TEZ-42",
        title: "",
        description: null,
        acceptanceCriteria: null,
        labels: [],
        comments: [],
        priority: null,
      };

      await expect(client.updateIssueStatus(makeProject(), issue, "Nonexistent")).rejects.toThrow(
        'Linear workflow state "Nonexistent" not found for team TEZ',
      );
    });

    it("throws LinearAuthError on authentication failure", async () => {
      const mockClient = {
        issues: vi.fn(),
        teams: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
      };
      MockLinearClient.mockImplementation(function () {
        return mockClient as unknown as InstanceType<typeof LinearClient>;
      });
      const client = new LinearWorkflowClientImpl("bad-key");
      const issue = {
        identifier: "TEZ-42",
        title: "",
        description: null,
        acceptanceCriteria: null,
        labels: [],
        comments: [],
        priority: null,
      };

      await expect(client.updateIssueStatus(makeProject(), issue, "Done")).rejects.toThrow(
        LinearAuthError,
      );
    });
  });
});

describe("createMissingKeyClient", () => {
  it("throws LinearAuthError on fetchIssue", () => {
    const client = createMissingKeyClient();
    expect(() => client.fetchIssue(makeProject(), "TEZ-1")).toThrow(LinearAuthError);
  });

  it("throws LinearAuthError on updateIssueStatus", () => {
    const client = createMissingKeyClient();
    const issue = {
      identifier: "TEZ-1",
      title: "",
      description: null,
      acceptanceCriteria: null,
      labels: [],
      comments: [],
      priority: null,
    };
    expect(() => client.updateIssueStatus(makeProject(), issue, "Done")).toThrow(LinearAuthError);
  });
});
