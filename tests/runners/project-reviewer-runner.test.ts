import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../src/config/index.js";
import {
  ProjectReviewerRunnerImpl,
  type PrReviewProcessOutput,
  type PrReviewProcessRunner,
} from "../../src/runners/project-reviewer-runner.js";
import type {
  ProjectCompletionIssue,
  ProjectCompletionRecord,
  ProjectReviewContext,
  PullRequestSnapshot,
} from "../../src/workflow/types.js";

function buildContext(): ProjectReviewContext {
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
    verification: {
      commands: [{ name: "test", command: "echo ok", timeoutMs: 1000 }],
    },
    timeouts: { builderMs: 60_000, reviewerMs: 30_000, verificationMs: 30_000 },
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
  const pullRequest: PullRequestSnapshot = {
    url: "https://github.com/org/loom/pull/42",
    number: 42,
    baseBranch: "main",
    devBranch: "dev",
    baseSha: "base-sha",
    devSha: "dev-sha",
    body: "PR body",
  };
  const issue: ProjectCompletionIssue = {
    id: "TEZ-1",
    title: "Wire X to Y",
    description: "Description",
    acceptanceCriteria: "AC",
    runId: "run-1",
    commitShas: ["sha-1"],
  };
  const completion: Partial<ProjectCompletionRecord> = {
    id: "comp-1",
    projectSlug: "loom",
  };
  return {
    completion: completion as ProjectCompletionRecord,
    project,
    pullRequest,
    diff: "diff text",
    shippedIssues: [issue],
    artifactDir: "/tmp/artifacts/comp-1",
  };
}

function fakeRunner(output: Partial<PrReviewProcessOutput>): PrReviewProcessRunner {
  return async () => ({
    exitCode: output.exitCode ?? 0,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
    stdoutLogPath: output.stdoutLogPath ?? "/log/stdout.log",
    stderrLogPath: output.stderrLogPath ?? "/log/stderr.log",
    timedOut: output.timedOut ?? false,
  });
}

describe("ProjectReviewerRunnerImpl", () => {
  it("returns a parsed PrReviewResult on a successful 'findings' response", async () => {
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: fakeRunner({
        stdout: JSON.stringify({
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
          summary: "1 P1",
        }),
      }),
    });

    const result = await runner.reviewProject(buildContext());

    expect(result.outcome).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.startLine).toBe(10);
    expect(result.summary).toBe("1 P1");
    expect(result.rawLogPath).toBe("/log/stdout.log");
  });

  it("returns 'pass' with empty findings on a clean response", async () => {
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: fakeRunner({
        stdout: JSON.stringify({
          outcome: "pass",
          findings: [],
          summary: "Clean",
        }),
      }),
    });

    const result = await runner.reviewProject(buildContext());

    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("maps process timeout to 'blocked' without a failure reason", async () => {
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: fakeRunner({ timedOut: true, exitCode: 124 }),
    });

    const result = await runner.reviewProject(buildContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toMatch(/timed out/i);
    expect(result.failureReason).toBeUndefined();
  });

  it("maps an auth error stderr to 'blocked' with runner_auth_missing", async () => {
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: fakeRunner({
        exitCode: 1,
        stderr: "Please run `claude /login` to authenticate.",
      }),
    });

    const result = await runner.reviewProject(buildContext());

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("runner_auth_missing");
  });

  it("maps malformed JSON stdout to 'blocked' with failureReason review_unparseable", async () => {
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: fakeRunner({ stdout: "not json at all" }),
    });

    const result = await runner.reviewProject(buildContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toMatch(/did not contain valid JSON|unexpected shape/i);
    expect(result.failureReason).toBe("review_unparseable");
  });

  it("invokes the process runner with the rendered PR review prompt", async () => {
    let capturedPrompt = "";
    const runner = new ProjectReviewerRunnerImpl({
      runProcess: async (input) => {
        capturedPrompt = input.prompt;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ outcome: "pass", findings: [], summary: "" }),
          stderr: "",
          stdoutLogPath: "/log/stdout.log",
          stderrLogPath: "/log/stderr.log",
          timedOut: false,
        };
      },
    });

    await runner.reviewProject(buildContext());

    expect(capturedPrompt).toMatch(/second pair of eyes/i);
    expect(capturedPrompt).toContain("https://github.com/org/loom/pull/42");
    expect(capturedPrompt).toContain("diff text");
  });
});
