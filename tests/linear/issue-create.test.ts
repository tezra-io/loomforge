import { describe, it, expect, vi } from "vitest";

import {
  createAdhocIssue,
  type LinearAdhocClient,
  type AdhocIssueParams,
} from "../../src/linear/issue-create.js";

function fakeClient(overrides: Partial<LinearAdhocClient> = {}): LinearAdhocClient {
  return {
    findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    findBacklogState: vi.fn(async () => ({ id: "state-backlog" })),
    findProjectIdByName: vi.fn(async () => "proj-1"),
    findTeamIdByKey: vi.fn(async () => "team-1"),
    createIssue: vi.fn(async () => ({
      identifier: "LOOM-456",
      url: "https://linear.app/x/issue/LOOM-456",
    })),
    ...overrides,
  };
}

const baseParams: AdhocIssueParams = {
  teamKey: "LOOM",
  projectName: "loom",
  labelName: "loomforge-adhoc",
  backlogStateName: "Backlog",
  title: "Fix the typo in README",
  description: "Fix the typo in README\n\n_Submitted via Loomforge ad-hoc on 2026-04-26._",
};

describe("createAdhocIssue", () => {
  it("creates an issue with the provided title, description, label, project, team, and backlog state", async () => {
    const client = fakeClient();
    const result = await createAdhocIssue(client, baseParams);

    expect(result).toEqual({
      identifier: "LOOM-456",
      url: "https://linear.app/x/issue/LOOM-456",
    });
    expect(client.createIssue).toHaveBeenCalledWith({
      title: baseParams.title,
      description: baseParams.description,
      teamId: "team-1",
      projectId: "proj-1",
      stateId: "state-backlog",
      labelIds: ["lbl-1"],
    });
  });

  it("creates the label when findLabel returns null", async () => {
    const client = fakeClient({
      findLabel: vi.fn(async () => null),
      createLabel: vi.fn(async () => ({ id: "lbl-new", name: "loomforge-adhoc" })),
    });
    await createAdhocIssue(client, baseParams);
    expect(client.createLabel).toHaveBeenCalledWith({
      teamId: "team-1",
      name: "loomforge-adhoc",
    });
  });

  it("retries label resolution once if createLabel fails (race), then re-finds", async () => {
    const findLabel = vi.fn();
    findLabel.mockResolvedValueOnce(null);
    findLabel.mockResolvedValueOnce({ id: "lbl-race", name: "loomforge-adhoc" });

    const client = fakeClient({
      findLabel,
      createLabel: vi.fn(async () => {
        throw new Error("label already exists");
      }),
    });

    const result = await createAdhocIssue(client, baseParams);
    expect(result.identifier).toBe("LOOM-456");
    expect(findLabel).toHaveBeenCalledTimes(2);
  });

  it("throws label_setup_failed if createLabel fails AND the second findLabel still returns null", async () => {
    const findLabel = vi.fn();
    findLabel.mockResolvedValueOnce(null);
    findLabel.mockResolvedValueOnce(null);

    const client = fakeClient({
      findLabel,
      createLabel: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });

    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/label_setup_failed/);
  });

  it("throws missing_backlog_state when findBacklogState returns null", async () => {
    const client = fakeClient({
      findBacklogState: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_backlog_state/);
  });

  it("throws missing_team when findTeamIdByKey returns null", async () => {
    const client = fakeClient({
      findTeamIdByKey: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_team/);
  });

  it("throws missing_project when findProjectIdByName returns null", async () => {
    const client = fakeClient({
      findProjectIdByName: vi.fn(async () => null),
    });
    await expect(createAdhocIssue(client, baseParams)).rejects.toThrow(/missing_project/);
  });
});
