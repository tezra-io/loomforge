import type {
  BuilderRunner,
  IssueSnapshot,
  LinearWorkflowClient,
  ReviewerRunner,
  WorktreeManager,
} from "../workflow/index.js";

export interface StubWorkflowDependencies {
  linear: LinearWorkflowClient;
  worktrees: WorktreeManager;
  builder: BuilderRunner;
  reviewer: ReviewerRunner;
}

export function createStubWorkflowDependencies(): StubWorkflowDependencies {
  return {
    linear: {
      fetchIssue: async (_project, issueId): Promise<IssueSnapshot> => ({
        identifier: issueId,
        title: `Stub issue ${issueId}`,
        description: "Stub issue fetched by the local daemon shell.",
        acceptanceCriteria: "Replace stub dependencies with real Linear, worktree, and runners.",
        labels: [],
        comments: [],
        priority: null,
      }),
      listProjectIssues: async () => [],
      updateIssueStatus: async () => {
        return;
      },
    },
    worktrees: {
      prepareWorkspace: async (project) => ({
        outcome: "success",
        workspace: {
          path: project.repoRoot,
          branchName: project.devBranch,
        },
      }),
      cleanupWorkspace: async () => ({
        outcome: "success",
        summary: "Workspace cleaned (stub)",
      }),
    },
    builder: {
      build: async ({ attempt }) => ({
        outcome: "success",
        summary: "Stub builder completed without editing files.",
        changedFiles: [],
        commitSha: `stub-${attempt.runId}-${attempt.attemptNumber}`,
        rawLogPath: "stub://builder.log",
      }),
      push: async () => ({
        outcome: "success",
        summary: "Stub push completed.",
        rawLogPath: "stub://push.log",
      }),
    },
    reviewer: {
      review: async () => ({
        outcome: "pass",
        findings: [],
        summary: "Stub review passed.",
        rawLogPath: "stub://review.log",
      }),
    },
  };
}
