import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import { SqliteRunStore } from "../../src/db/index.js";
import type { RunRecord } from "../../src/workflow/types.js";

const project: ProjectConfig = {
  slug: "loom",
  repoRoot: "/repos/loom",
  defaultBranch: "main",
  devBranch: "dev",
  linearTeamKey: null,
  linearProjectName: null,
  builder: "claude",
  reviewer: "claude",
  runtimeDataRoot: "/tmp/data",
  verification: { commands: [{ name: "t", command: "echo ok", timeoutMs: 1000 }] },
  timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
  review: {
    maxRevisionLoops: 3,
    blockingSeverities: ["P0", "P1"],
    postPrReviewComments: true,
    reviewPartialPr: false,
  },
  linearStatuses: {
    inProgress: "In Progress",
    inReview: "In Review",
    done: "Done",
    blocked: "Blocked",
  },
};

function buildRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    projectSlug: "loom",
    issueId: "TEZ-1",
    source: "linear",
    state: "queued",
    failureReason: null,
    revisionCount: 0,
    queuePosition: null,
    issueSnapshot: {
      identifier: "TEZ-1",
      title: "t",
      description: "d",
      acceptanceCriteria: "a",
      labels: [],
      comments: [],
      priority: null,
    },
    workspace: null,
    attempts: [],
    events: [],
    handoff: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteRunStore.listRecoverableRuns", () => {
  it("excludes runs that ended in already_complete (terminal)", () => {
    const store = SqliteRunStore.open(":memory:");
    try {
      store.saveProject(project);
      store.saveRun(buildRun({ id: "queued-1", issueId: "TEZ-100", state: "queued" }));
      store.saveRun(
        buildRun({
          id: "ac-1",
          issueId: "TEZ-101",
          state: "already_complete",
          updatedAt: "2026-05-01T01:00:00.000Z",
        }),
      );
      store.saveRun(
        buildRun({
          id: "shipped-1",
          issueId: "TEZ-102",
          state: "shipped",
          updatedAt: "2026-05-01T02:00:00.000Z",
        }),
      );

      const recoverable = store.listRecoverableRuns();
      const ids = recoverable.map((r) => r.id);
      expect(ids).toContain("queued-1");
      expect(ids).not.toContain("ac-1");
      expect(ids).not.toContain("shipped-1");
    } finally {
      store.close();
    }
  });
});
