import { describe, expect, it } from "vitest";

import { SqliteRunStore } from "../../src/db/sqlite-run-store.js";
import type {
  CreateProjectCompletionInput,
  ProjectArtifactRecord,
  ProjectCompletionIssue,
  ProjectCompletionRecord,
} from "../../src/workflow/types.js";

function seedProject(store: SqliteRunStore, slug = "loom"): void {
  store.saveProject({
    slug,
    repoRoot: "/repos/loom",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/tmp/data",
    verification: {
      commands: [{ name: "test", command: "echo ok", timeoutMs: 10_000 }],
    },
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
  });
}

function openStore(): SqliteRunStore {
  const store = SqliteRunStore.open(":memory:");
  seedProject(store);
  return store;
}

function buildIssue(id: string, runId: string): ProjectCompletionIssue {
  return {
    id,
    title: `Issue ${id}`,
    description: `Desc for ${id}`,
    acceptanceCriteria: `AC for ${id}`,
    runId,
    commitShas: [`sha-${id}`],
  };
}

function buildInput(
  overrides: Partial<CreateProjectCompletionInput> = {},
): CreateProjectCompletionInput {
  return {
    id: "comp-1",
    projectSlug: "loom",
    baseBranch: "main",
    devBranch: "dev",
    shippedIssues: [buildIssue("TEZ-1", "run-1"), buildIssue("TEZ-2", "run-2")],
    alreadyCompleteIssueIds: [],
    failedIssueIds: [],
    blockedIssueIds: [],
    cancelledIssueIds: [],
    postPrReviewComments: true,
    blockingSeverities: ["P0", "P1"],
    reviewPartialPr: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteRunStore project completion persistence", () => {
  it("creates a new project completion in pending state and persists shipped issues", () => {
    const store = openStore();
    try {
      const created = store.createOrResumeProjectCompletion(buildInput());

      expect(created).toMatchObject({
        id: "comp-1",
        projectSlug: "loom",
        state: "pending",
        baseBranch: "main",
        devBranch: "dev",
        postPrReviewComments: true,
        blockingSeverities: ["P0", "P1"],
        reviewPartialPr: false,
      });
      expect(created.shippedIssues).toHaveLength(2);
      expect(created.shippedIssues[0]?.id).toBe("TEZ-1");
      expect(created.findingCounts).toEqual({ p0: 0, p1: 0, p2: 0 });
      expect(created.completedAt).toBeNull();

      const fetched = store.getProjectCompletion("comp-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.shippedIssues).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("returns the existing active completion instead of creating a duplicate", () => {
    const store = openStore();
    try {
      const first = store.createOrResumeProjectCompletion(buildInput({ id: "comp-1" }));
      const second = store.createOrResumeProjectCompletion(
        buildInput({ id: "comp-2", createdAt: "2026-05-01T01:00:00.000Z" }),
      );

      expect(second.id).toBe(first.id);
      expect(second.id).toBe("comp-1");

      const latest = store.getLatestProjectCompletion("loom");
      expect(latest?.id).toBe("comp-1");

      const active = store.listActiveProjectCompletions();
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe("comp-1");
    } finally {
      store.close();
    }
  });

  it("allows a new completion after the previous one reached a terminal state", () => {
    const store = openStore();
    try {
      const first = store.createOrResumeProjectCompletion(buildInput({ id: "comp-1" }));

      const completed: ProjectCompletionRecord = {
        ...first,
        state: "merge_ready",
        completedAt: "2026-05-01T00:30:00.000Z",
        updatedAt: "2026-05-01T00:30:00.000Z",
      };
      store.updateProjectCompletion(completed);

      const second = store.createOrResumeProjectCompletion(
        buildInput({ id: "comp-2", createdAt: "2026-05-01T01:00:00.000Z" }),
      );

      expect(second.id).toBe("comp-2");
      expect(second.state).toBe("pending");

      const latest = store.getLatestProjectCompletion("loom");
      expect(latest?.id).toBe("comp-2");

      const active = store.listActiveProjectCompletions();
      expect(active.map((record) => record.id)).toEqual(["comp-2"]);
    } finally {
      store.close();
    }
  });

  it("round-trips PR review fields, finding counts, and lease metadata", () => {
    const store = openStore();
    try {
      const created = store.createOrResumeProjectCompletion(buildInput());
      const updated: ProjectCompletionRecord = {
        ...created,
        state: "merge_ready",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        baseSha: "base-sha",
        devSha: "dev-sha",
        reviewResult: {
          outcome: "findings",
          findings: [
            {
              severity: "P1",
              title: "missing wiring",
              detail: "src/x.ts does not import src/y.ts",
              file: "src/x.ts",
              startLine: 10,
              endLine: 12,
            },
          ],
          summary: "1 P1 finding",
          rawLogPath: "/artifacts/comp-1/reviewer.log",
        },
        prReviewOutcome: "posted",
        prReviewUrl: "https://github.com/org/repo/pull/42#pullrequestreview-1",
        findingCounts: { p0: 0, p1: 1, p2: 0 },
        completedAt: "2026-05-01T00:45:00.000Z",
        updatedAt: "2026-05-01T00:45:00.000Z",
      };
      store.updateProjectCompletion(updated);
      store.acquireProjectCompletionLease(
        "comp-1",
        "daemon-1",
        "2026-05-01T01:00:00.000Z",
        "2026-05-01T00:30:00.000Z",
      );

      const fetched = store.getProjectCompletion("comp-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(fetched?.prNumber).toBe(42);
      expect(fetched?.baseSha).toBe("base-sha");
      expect(fetched?.devSha).toBe("dev-sha");
      expect(fetched?.reviewResult?.outcome).toBe("findings");
      expect(fetched?.reviewResult?.findings[0]?.startLine).toBe(10);
      expect(fetched?.reviewResult?.findings[0]?.endLine).toBe(12);
      expect(fetched?.prReviewOutcome).toBe("posted");
      expect(fetched?.prReviewUrl).toBe("https://github.com/org/repo/pull/42#pullrequestreview-1");
      expect(fetched?.findingCounts).toEqual({ p0: 0, p1: 1, p2: 0 });
      expect(fetched?.leaseOwner).toBe("daemon-1");
      expect(fetched?.leaseExpiresAt).toBe("2026-05-01T01:00:00.000Z");
      expect(fetched?.completedAt).toBe("2026-05-01T00:45:00.000Z");
    } finally {
      store.close();
    }
  });

  it("acquires a lease only when none is held or the prior lease has expired", () => {
    const store = openStore();
    try {
      store.createOrResumeProjectCompletion(buildInput({ id: "comp-1" }));

      const acquiredA = store.acquireProjectCompletionLease(
        "comp-1",
        "owner-a",
        "2026-05-01T00:05:00.000Z",
        "2026-05-01T00:00:00.000Z",
      );
      expect(acquiredA).toBe(true);

      const acquiredBWhileHeld = store.acquireProjectCompletionLease(
        "comp-1",
        "owner-b",
        "2026-05-01T00:10:00.000Z",
        "2026-05-01T00:01:00.000Z",
      );
      expect(acquiredBWhileHeld).toBe(false);

      // After expiry, owner-b can acquire.
      const acquiredBAfterExpiry = store.acquireProjectCompletionLease(
        "comp-1",
        "owner-b",
        "2026-05-01T00:15:00.000Z",
        "2026-05-01T00:06:00.000Z",
      );
      expect(acquiredBAfterExpiry).toBe(true);
      expect(store.getProjectCompletion("comp-1")?.leaseOwner).toBe("owner-b");

      // Release returns the slot to "no owner".
      store.releaseProjectCompletionLease("comp-1", "owner-b", "2026-05-01T00:07:00.000Z");
      expect(store.getProjectCompletion("comp-1")?.leaseOwner).toBeNull();
    } finally {
      store.close();
    }
  });

  it("saves and lists project artifacts scoped by completion id", () => {
    const store = openStore();
    try {
      store.createOrResumeProjectCompletion(buildInput({ id: "comp-1" }));

      const artifact: ProjectArtifactRecord = {
        id: "art-1",
        completionId: "comp-1",
        kind: "pr_diff",
        path: "/artifacts/comp-1/diff.patch",
        metadata: { bytes: 1024 },
        createdAt: "2026-05-01T00:10:00.000Z",
      };
      store.saveProjectArtifact(artifact);

      const second: ProjectArtifactRecord = {
        id: "art-2",
        completionId: "comp-1",
        kind: "reviewer_stdout",
        path: "/artifacts/comp-1/reviewer.stdout.log",
        metadata: {},
        createdAt: "2026-05-01T00:11:00.000Z",
      };
      store.saveProjectArtifact(second);

      const listed = store.listProjectArtifacts("comp-1");
      expect(listed).toHaveLength(2);
      expect(listed[0]?.id).toBe("art-1");
      expect(listed[0]?.metadata).toEqual({ bytes: 1024 });
      expect(listed[1]?.kind).toBe("reviewer_stdout");
    } finally {
      store.close();
    }
  });

  it("getLatestProjectCompletion returns the most recent record by createdAt", () => {
    const store = openStore();
    try {
      const first = store.createOrResumeProjectCompletion(
        buildInput({ id: "comp-1", createdAt: "2026-05-01T00:00:00.000Z" }),
      );
      store.updateProjectCompletion({
        ...first,
        state: "blocked",
        failureReason: "incomplete_batch",
        completedAt: "2026-05-01T00:05:00.000Z",
        updatedAt: "2026-05-01T00:05:00.000Z",
      });

      store.createOrResumeProjectCompletion(
        buildInput({ id: "comp-2", createdAt: "2026-05-01T01:00:00.000Z" }),
      );

      const latest = store.getLatestProjectCompletion("loom");
      expect(latest?.id).toBe("comp-2");
    } finally {
      store.close();
    }
  });
});
