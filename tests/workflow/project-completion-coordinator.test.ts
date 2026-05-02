import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import { SqliteRunStore } from "../../src/db/sqlite-run-store.js";
import { ProjectCompletionCoordinatorImpl } from "../../src/workflow/project-completion.js";
import type {
  CreateOrUpdatePrResult,
  DiffSnapshotResult,
  GhPrReviewPoster,
  PrReviewPostResult,
  PrReviewResult,
  ProjectDiffSnapshotter,
  ProjectReviewerRunner,
  PullRequestManager,
  RunRecord,
} from "../../src/workflow/types.js";

function buildProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug: "loom",
    repoRoot: "/repos/loom",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: null,
    linearProjectName: null,
    builder: "claude",
    reviewer: "claude",
    runtimeDataRoot: "/tmp/data",
    verification: {
      commands: [{ name: "test", command: "echo ok", timeoutMs: 1000 }],
    },
    timeouts: { builderMs: 60_000, reviewerMs: 60_000, verificationMs: 30_000 },
    review: {
      maxRevisionLoops: 3,
      blockingSeverities: ["P0", "P1"],
      postPrReviewComments: false,
      reviewPartialPr: false,
    },
    linearStatuses: {
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      blocked: "Blocked",
    },
    ...overrides,
  };
}

function buildRun(opts: {
  id: string;
  issueId: string;
  state: RunRecord["state"];
  title?: string | null;
  commitSha?: string | null;
}): RunRecord {
  const attempt = opts.commitSha
    ? [
        {
          id: `${opts.id}:attempt:1`,
          runId: opts.id,
          attemptNumber: 1,
          outcome: opts.state,
          builderResult: {
            outcome: "success" as const,
            summary: "ok",
            changedFiles: [],
            commitSha: opts.commitSha,
            rawLogPath: "/log",
          },
          verificationResult: null,
          reviewResult: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ]
    : [];
  return {
    id: opts.id,
    projectSlug: "loom",
    issueId: opts.issueId,
    source: "linear",
    state: opts.state,
    failureReason: null,
    revisionCount: 0,
    queuePosition: null,
    issueSnapshot: {
      identifier: opts.issueId,
      title: opts.title ?? `Title for ${opts.issueId}`,
      description: `Desc ${opts.issueId}`,
      acceptanceCriteria: `AC ${opts.issueId}`,
      labels: [],
      comments: [],
      priority: null,
    },
    workspace: null,
    attempts: attempt,
    events: [],
    handoff: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function seedProject(store: SqliteRunStore, project: ProjectConfig): void {
  store.saveProject(project);
}

function fakeIdGen(prefix = "comp"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function fakeClock(start = "2026-05-01T00:00:00.000Z"): () => string {
  let ms = Date.parse(start);
  return () => {
    const value = new Date(ms).toISOString();
    ms += 1000;
    return value;
  };
}

function passingPullRequestManager(pullRequestNumber = 7): PullRequestManager {
  return {
    createOrUpdatePr: vi.fn(
      async (project, content): Promise<CreateOrUpdatePrResult> => ({
        outcome: "success",
        pullRequest: {
          url: `https://github.com/org/${project.slug}/pull/${pullRequestNumber}`,
          number: pullRequestNumber,
          baseBranch: project.defaultBranch,
          devBranch: project.devBranch,
          baseSha: "base-sha",
          devSha: "dev-sha",
          body: content.body,
        },
      }),
    ),
  };
}

interface RecordingWriter {
  writeText: (path: string, contents: string) => Promise<void>;
  files: Map<string, string>;
}

function recordingArtifactWriter(): RecordingWriter {
  const files = new Map<string, string>();
  return {
    files,
    writeText: async (path: string, contents: string) => {
      files.set(path, contents);
    },
  };
}

function passingDiffSnapshotter(diff = "diff text"): ProjectDiffSnapshotter {
  return {
    snapshot: vi.fn(
      async (): Promise<DiffSnapshotResult> => ({
        outcome: "success",
        diff,
        baseSha: "base-sha",
        devSha: "dev-sha",
      }),
    ),
  };
}

function unavailableDiffSnapshotter(
  reason: "fetch_failed" | "diff_failed" = "diff_failed",
): ProjectDiffSnapshotter {
  return {
    snapshot: vi.fn(
      async (): Promise<DiffSnapshotResult> => ({
        outcome: "unavailable",
        reason,
        summary: `simulated ${reason}`,
      }),
    ),
  };
}

function reviewerReturning(result: PrReviewResult): ProjectReviewerRunner {
  return { reviewProject: vi.fn(async () => result) };
}

function posterReturning(result: PrReviewPostResult): GhPrReviewPoster {
  return { post: vi.fn(async () => result) };
}

function failingPullRequestManager(reason: "push_failed" | "gh_failed"): PullRequestManager {
  return {
    createOrUpdatePr: vi.fn(async () => ({
      outcome: "failed" as const,
      reason,
      summary: `simulated ${reason}`,
    })),
  };
}

describe("ProjectCompletionCoordinator pass path", () => {
  it("creates the PR and reaches merge_ready with skipped_disabled when comments are off", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({
            id: "run-1",
            issueId: "TEZ-1",
            state: "shipped",
            commitSha: "sha-1",
          }),
          buildRun({
            id: "run-2",
            issueId: "TEZ-2",
            state: "shipped",
            commitSha: "sha-2",
          }),
        ],
        triggerRunId: "run-2",
      });

      expect(record).toMatchObject({
        state: "merge_ready",
        prReviewOutcome: "skipped_disabled",
        prUrl: "https://github.com/org/loom/pull/7",
        prNumber: 7,
        baseSha: "base-sha",
        devSha: "dev-sha",
      });
      expect(record.shippedIssues).toHaveLength(2);
      expect(record.shippedIssues[0]?.commitShas).toEqual(["sha-1"]);
      expect(record.completedAt).not.toBeNull();
      expect(pullRequests.createOrUpdatePr).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("blocks with incomplete_batch when canonical runs include failed issues and reviewPartialPr=false", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
          buildRun({ id: "run-2", issueId: "TEZ-2", state: "failed" }),
        ],
        triggerRunId: "run-2",
      });

      expect(record.state).toBe("blocked");
      expect(record.failureReason).toBe("incomplete_batch");
      expect(record.failedIssueIds).toEqual(["TEZ-2"]);
      expect(record.prUrl).toBeNull();
      expect(pullRequests.createOrUpdatePr).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("skips with zero_shipped_issues when no canonical run is shipped", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [buildRun({ id: "run-1", issueId: "TEZ-1", state: "already_complete" })],
        triggerRunId: null,
      });

      expect(record.state).toBe("skipped");
      expect(record.failureReason).toBe("zero_shipped_issues");
      expect(record.alreadyCompleteIssueIds).toEqual(["TEZ-1"]);
      expect(pullRequests.createOrUpdatePr).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("blocks with pr_creation_failed when the PR manager returns failure", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = failingPullRequestManager("gh_failed");
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("blocked");
      expect(record.failureReason).toBe("pr_creation_failed");
      expect(record.prUrl).toBeNull();
    } finally {
      store.close();
    }
  });

  it("creates a PR for partial batches when reviewPartialPr=true", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: false,
        reviewPartialPr: true,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
          buildRun({ id: "run-2", issueId: "TEZ-2", state: "failed" }),
        ],
        triggerRunId: "run-2",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prUrl).toBe("https://github.com/org/loom/pull/7");
      expect(record.failedIssueIds).toEqual(["TEZ-2"]);
      expect(pullRequests.createOrUpdatePr).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("posts a GitHub PR review when reviewer returns findings and poster succeeds", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const diffSnapshotter = passingDiffSnapshotter("compare diff");
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [
        { severity: "P1", title: "missing wiring", detail: "x", file: "src/x.ts", startLine: 10 },
        { severity: "P2", title: "naming", detail: "y", file: "src/y.ts", startLine: 4 },
      ],
      summary: "1 P1, 1 P2",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({
      outcome: "posted",
      reviewUrl: "https://github.com/org/loom/pull/7#pullrequestreview-9",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter,
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("posted");
      expect(record.prReviewUrl).toBe("https://github.com/org/loom/pull/7#pullrequestreview-9");
      expect(record.findingCounts).toEqual({ p0: 0, p1: 1, p2: 1 });
      expect(record.reviewResult?.summary).toBe("1 P1, 1 P2");
      expect(reviewer.reviewProject).toHaveBeenCalledTimes(1);
      expect(poster.post).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("records skipped_no_findings on a clean reviewer pass", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "pass",
      findings: [],
      summary: "Clean",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({
      outcome: "posted",
      reviewUrl: "(unused)",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("skipped_no_findings");
      expect(poster.post).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("records skipped_malformed when the reviewer blocked with review_unparseable failureReason", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "blocked",
      findings: [],
      summary: "Reviewer output did not contain valid JSON",
      rawLogPath: "/log/stdout.log",
      failureReason: "review_unparseable",
    });
    const poster = posterReturning({ outcome: "posted", reviewUrl: "(unused)" });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("skipped_malformed");
      expect(poster.post).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("records skipped_runner_blocked when the reviewer returns blocked", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "blocked",
      findings: [],
      summary: "diff exceeds context window",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({ outcome: "posted", reviewUrl: "(unused)" });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("skipped_runner_blocked");
      expect(record.reviewResult?.summary).toMatch(/diff exceeds/i);
      expect(poster.post).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("records skipped_diff_unavailable when the diff snapshot fails (reviewer not called)", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "pass",
      findings: [],
      summary: "(unused)",
      rawLogPath: "(unused)",
    });
    const poster = posterReturning({ outcome: "posted", reviewUrl: "(unused)" });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: unavailableDiffSnapshotter("diff_failed"),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("skipped_diff_unavailable");
      expect(reviewer.reviewProject).not.toHaveBeenCalled();
      expect(poster.post).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("records post_failed when reviewer returns findings but poster fails", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [{ severity: "P0", title: "broken", detail: "z", file: "src/a.ts", startLine: 1 }],
      summary: "1 P0",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({
      outcome: "post_failed",
      summary: "HTTP 403: Resource not accessible",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      expect(record.state).toBe("merge_ready");
      expect(record.prReviewOutcome).toBe("post_failed");
      expect(record.findingCounts).toEqual({ p0: 1, p1: 0, p2: 0 });
      expect(record.reviewResult?.summary).toBe("1 P0");
      expect(poster.post).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("sanitizes findings that leak issue acceptance criteria before posting", async () => {
    const acText =
      "When a user submits the form with an invalid email the API must return 422 with a typed error object containing field and message.";
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const issueWithAc = buildRun({
      id: "run-1",
      issueId: "TEZ-1",
      state: "shipped",
      commitSha: "sha-1",
    });
    const baseSnapshot = issueWithAc.issueSnapshot;
    if (!baseSnapshot) throw new Error("expected issueSnapshot from buildRun");
    const issueWithAcAcceptance = {
      ...issueWithAc,
      issueSnapshot: {
        ...baseSnapshot,
        acceptanceCriteria: acText,
      },
    };
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [
        {
          severity: "P1",
          title: "leaking",
          detail: `From the issue: ${acText}`,
          file: "src/x.ts",
          startLine: 1,
        },
        {
          severity: "P2",
          title: "clean",
          detail: "Use camelCase for the new helper functions in the validator module.",
          file: "src/y.ts",
          startLine: 4,
        },
      ],
      summary: "1 P1, 1 P2",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({
      outcome: "posted",
      reviewUrl: "https://github.com/org/loom/pull/7#r",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      await coordinator.startOrResume({
        project,
        canonicalRuns: [issueWithAcAcceptance],
        triggerRunId: "run-1",
      });

      expect(poster.post).toHaveBeenCalledTimes(1);
      const postedReview = (poster.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
        | PrReviewResult
        | undefined;
      expect(postedReview?.findings).toHaveLength(1);
      expect(postedReview?.findings[0]?.title).toBe("clean");
    } finally {
      store.close();
    }
  });

  it("writes project-handoff.json on every terminal path including markTerminal", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const writer = recordingArtifactWriter();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      artifactWriter: writer,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [buildRun({ id: "run-1", issueId: "TEZ-1", state: "already_complete" })],
        triggerRunId: null,
      });

      expect(record.state).toBe("skipped");
      const handoffEntry = [...writer.files.entries()].find(([path]) =>
        path.endsWith("project-handoff.json"),
      );
      expect(handoffEntry).toBeDefined();
      const handoff = JSON.parse(handoffEntry?.[1] ?? "{}") as Record<string, unknown>;
      expect(handoff.state).toBe("skipped");
      expect(handoff.recommendedNextAction).toBe("none");
      const artifacts = store.listProjectArtifacts(record.id);
      expect(artifacts.find((a) => a.kind === "project-handoff")).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("writes a gh-post-stderr artifact when the poster fails", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const writer = recordingArtifactWriter();
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [{ severity: "P0", title: "x", detail: "y", file: "a", startLine: 1 }],
      summary: "1 P0",
      rawLogPath: "/log/stdout.log",
    });
    const poster = posterReturning({
      outcome: "post_failed",
      summary: "HTTP 403 Resource not accessible",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      artifactWriter: writer,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });
      expect(record.prReviewOutcome).toBe("post_failed");
      const stderrEntry = [...writer.files.entries()].find(([path]) =>
        path.endsWith("gh-post-stderr.txt"),
      );
      expect(stderrEntry?.[1]).toContain("HTTP 403");
      const artifacts = store.listProjectArtifacts(record.id);
      expect(artifacts.find((a) => a.kind === "gh-post-stderr")).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("persists a pr-reviewer-stdout artifact before the merge_ready transition", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [{ severity: "P1", title: "x", detail: "y", file: "a", startLine: 1 }],
      summary: "1 P1",
      rawLogPath: "/log/pr-reviewer-stdout.log",
    });
    const poster = posterReturning({
      outcome: "posted",
      reviewUrl: "https://github.com/org/loom/pull/7#r",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const record = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });

      const artifacts = store.listProjectArtifacts(record.id);
      const kinds = artifacts.map((a) => a.kind).sort();
      expect(kinds).toEqual([
        "pr-diff",
        "pr-review-posted",
        "pr-reviewer-prompt",
        "pr-reviewer-stdout",
        "project-handoff",
        "shipped-issues",
      ]);
      const stdout = artifacts.find((a) => a.kind === "pr-reviewer-stdout");
      expect(stdout?.path).toBe("/log/pr-reviewer-stdout.log");
      expect(stdout?.metadata).toMatchObject({
        outcome: "findings",
        findings: 1,
        prReviewOutcome: "posted",
      });
    } finally {
      store.close();
    }
  });

  it("retries a merge_ready+post_failed completion by re-running the review path", async () => {
    const project = buildProject({
      review: {
        maxRevisionLoops: 3,
        blockingSeverities: ["P0", "P1"],
        postPrReviewComments: true,
        reviewPartialPr: false,
      },
    });
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);

    let postCalls = 0;
    const poster: GhPrReviewPoster = {
      post: vi.fn(async () => {
        postCalls += 1;
        if (postCalls === 1) {
          return { outcome: "post_failed" as const, summary: "HTTP 502" };
        }
        return {
          outcome: "posted" as const,
          reviewUrl: "https://github.com/org/loom/pull/7#r2",
        };
      }),
    };
    const reviewer = reviewerReturning({
      outcome: "findings",
      findings: [{ severity: "P1", title: "x", detail: "y", file: "a", startLine: 1 }],
      summary: "1 P1",
      rawLogPath: "/log/stdout.log",
    });
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      diffSnapshotter: passingDiffSnapshotter(),
      reviewer,
      poster,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const initial = await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });
      expect(initial.prReviewOutcome).toBe("post_failed");

      const retried = await coordinator.retry(project);
      expect(retried.outcome).toBe("retried");
      if (retried.outcome === "retried") {
        expect(retried.completion.prReviewOutcome).toBe("posted");
        expect(retried.completion.prReviewUrl).toContain("#r2");
      }
      expect(postCalls).toBe(2);
    } finally {
      store.close();
    }
  });

  it("retry returns no_completion when no completion exists for the project", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: passingPullRequestManager(),
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      const result = await coordinator.retry(project);
      expect(result.outcome).toBe("no_completion");
    } finally {
      store.close();
    }
  });

  it("retry returns not_retryable for already-posted merge_ready completions", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinator = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      newId: fakeIdGen(),
      now: fakeClock(),
    });
    try {
      await coordinator.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      });
      // postPrReviewComments=false → skipped_disabled, which is not retryable
      const retried = await coordinator.retry(project);
      expect(retried.outcome).toBe("not_retryable");
      // The PR manager should not be called again on a no-op retry.
      expect(pullRequests.createOrUpdatePr).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("acquires a lease so concurrent coordinators do not duplicate side effects", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    const coordinatorA = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      leaseOwnerId: "coord-a",
      newId: fakeIdGen("a"),
      now: fakeClock("2026-05-01T00:00:00.000Z"),
    });
    const coordinatorB = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      leaseOwnerId: "coord-b",
      newId: fakeIdGen("b"),
      now: fakeClock("2026-05-01T00:00:00.000Z"),
    });
    try {
      const trigger = {
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      };
      const [a, b] = await Promise.all([
        coordinatorA.startOrResume(trigger),
        coordinatorB.startOrResume(trigger),
      ]);

      expect(a.id).toBe(b.id);
      expect(pullRequests.createOrUpdatePr).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("releases the side-effect path to a new owner once the lease expires", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    const pullRequests = passingPullRequestManager();
    let nowMs = Date.parse("2026-05-01T00:00:00.000Z");
    const sharedNow = () => {
      const value = new Date(nowMs).toISOString();
      nowMs += 1000;
      return value;
    };

    const coordinatorA = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests,
      leaseOwnerId: "coord-a",
      leaseTtlMs: 1000,
      newId: fakeIdGen("a"),
      now: sharedNow,
    });
    try {
      const trigger = {
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: "run-1",
      };
      const first = await coordinatorA.startOrResume(trigger);
      expect(first.state).toBe("merge_ready");

      // Re-open the active state to simulate a stuck completion.
      store.updateProjectCompletion({ ...first, state: "creating_pr", completedAt: null });
      // Advance time past the lease expiry.
      nowMs += 5000;

      const coordinatorB = new ProjectCompletionCoordinatorImpl({
        store,
        pullRequests,
        leaseOwnerId: "coord-b",
        leaseTtlMs: 1000,
        newId: fakeIdGen("b"),
        now: sharedNow,
      });
      const resumed = await coordinatorB.startOrResume(trigger);
      expect(resumed.id).toBe(first.id);
      expect(resumed.state).toBe("merge_ready");
    } finally {
      store.close();
    }
  });

  it("returns the existing active completion when called twice (idempotent restart)", async () => {
    const project = buildProject();
    const store = SqliteRunStore.open(":memory:");
    seedProject(store, project);
    // First call uses a manager that hangs by completing immediately, but second call should see existing record.
    const firstManager = passingPullRequestManager();
    const coordinator1 = new ProjectCompletionCoordinatorImpl({
      store,
      pullRequests: firstManager,
      newId: fakeIdGen("comp-a"),
      now: fakeClock(),
    });
    try {
      const first = await coordinator1.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: null,
      });
      expect(first.state).toBe("merge_ready");

      // Manually re-open the active state to simulate a resume scenario.
      store.updateProjectCompletion({ ...first, state: "creating_pr", completedAt: null });

      const secondManager = passingPullRequestManager();
      const coordinator2 = new ProjectCompletionCoordinatorImpl({
        store,
        pullRequests: secondManager,
        newId: fakeIdGen("comp-b"),
        now: fakeClock(),
      });
      const resumed = await coordinator2.startOrResume({
        project,
        canonicalRuns: [
          buildRun({ id: "run-1", issueId: "TEZ-1", state: "shipped", commitSha: "sha-1" }),
        ],
        triggerRunId: null,
      });
      expect(resumed.id).toBe(first.id);
      // Resume should drive the existing record back to merge_ready and call the PR manager again.
      expect(resumed.state).toBe("merge_ready");
      expect(secondManager.createOrUpdatePr).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
});
