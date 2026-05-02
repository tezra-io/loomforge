import { describe, expect, it } from "vitest";

import {
  GhPrReviewPoster,
  type PostCommandRunner,
} from "../../src/worktrees/gh-pr-review-poster.js";
import type { PrReviewResult, PullRequestSnapshot } from "../../src/workflow/types.js";

interface CapturedCall {
  cmd: string;
  args: string[];
  cwd?: string;
  stdin?: string;
}

interface ScriptedCall {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function runnerFromScript(calls: ScriptedCall[]): {
  runner: PostCommandRunner;
  invocations: CapturedCall[];
} {
  const invocations: CapturedCall[] = [];
  let index = 0;
  const runner: PostCommandRunner = async (cmd, args, opts) => {
    invocations.push({ cmd, args, cwd: opts.cwd, stdin: opts.stdin });
    const expected = calls[index++];
    if (!expected) {
      throw new Error(`Unexpected command #${index}: ${cmd} ${args.join(" ")}`);
    }
    return {
      exitCode: expected.exitCode ?? 0,
      stdout: expected.stdout ?? "",
      stderr: expected.stderr ?? "",
    };
  };
  return { runner, invocations };
}

const samplePr: PullRequestSnapshot = {
  url: "https://github.com/org/loom/pull/42",
  number: 42,
  baseBranch: "main",
  devBranch: "dev",
  baseSha: "base-sha",
  devSha: "dev-sha",
  body: "PR body",
};

function reviewWith(findings: PrReviewResult["findings"], summary = "Summary"): PrReviewResult {
  return {
    outcome: "findings",
    findings,
    summary,
    rawLogPath: "/log/stdout.log",
  };
}

describe("GhPrReviewPoster.post", () => {
  it("posts a PR review with line-anchored inline comments", async () => {
    const { runner, invocations } = runnerFromScript([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          html_url: "https://github.com/org/loom/pull/42#pullrequestreview-1",
        }),
      },
    ]);
    const poster = new GhPrReviewPoster({ runner });

    const review = reviewWith(
      [
        {
          severity: "P1",
          title: "missing wiring",
          detail: "src/x.ts does not import src/y.ts",
          file: "src/x.ts",
          startLine: 10,
          endLine: 12,
        },
        {
          severity: "P2",
          title: "naming",
          detail: "use camelCase",
          file: "src/y.ts",
          startLine: 4,
        },
      ],
      "1 P1, 1 P2 — see comments",
    );

    const result = await poster.post(samplePr, review);

    expect(result).toEqual({
      outcome: "posted",
      reviewUrl: "https://github.com/org/loom/pull/42#pullrequestreview-1",
    });
    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    expect(call?.cmd).toBe("gh");
    expect(call?.args[0]).toBe("api");
    expect(call?.args).toContain("repos/org/loom/pulls/42/reviews");
    expect(call?.args).toContain("--input");
    expect(call?.args).toContain("-");
    const payload = JSON.parse(call?.stdin ?? "{}") as {
      event: string;
      body: string;
      comments: Array<{
        path: string;
        line: number;
        side: string;
        start_line?: number;
        start_side?: string;
        body: string;
      }>;
    };
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toContain("1 P1, 1 P2");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toMatchObject({
      path: "src/x.ts",
      start_line: 10,
      start_side: "RIGHT",
      line: 12,
      side: "RIGHT",
    });
    expect(payload.comments[0]?.body).toContain("missing wiring");
    expect(payload.comments[0]?.body).toContain("P1");
    expect(payload.comments[1]).toMatchObject({
      path: "src/y.ts",
      line: 4,
      side: "RIGHT",
    });
    expect(payload.comments[1]).not.toHaveProperty("start_line");
    expect(payload.comments[1]).not.toHaveProperty("start_side");
  });

  it("renders findings without line anchors in the body, not as inline comments", async () => {
    const { runner, invocations } = runnerFromScript([
      {
        exitCode: 0,
        stdout: JSON.stringify({ html_url: "https://github.com/org/loom/pull/42#r" }),
      },
    ]);
    const poster = new GhPrReviewPoster({ runner });

    const review = reviewWith(
      [
        { severity: "P0", title: "no anchor", detail: "broad concern" },
        { severity: "P1", title: "anchored", detail: "ok", file: "src/a.ts", startLine: 5 },
      ],
      "1 P0, 1 P1",
    );

    const result = await poster.post(samplePr, review);

    expect(result.outcome).toBe("posted");
    const call = invocations[0];
    const payload = JSON.parse(call?.stdin ?? "{}") as {
      body: string;
      comments: Array<{ path: string }>;
    };
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]?.path).toBe("src/a.ts");
    expect(payload.body).toContain("no anchor");
    expect(payload.body).toContain("P0");
  });

  it("returns post_failed when gh exits non-zero", async () => {
    const { runner } = runnerFromScript([
      { exitCode: 1, stderr: "HTTP 403: Resource not accessible by integration" },
    ]);
    const poster = new GhPrReviewPoster({ runner });

    const review = reviewWith([
      { severity: "P1", title: "x", detail: "y", file: "a", startLine: 1 },
    ]);

    const result = await poster.post(samplePr, review);

    expect(result.outcome).toBe("post_failed");
    if (result.outcome === "post_failed") {
      expect(result.summary).toContain("403");
    }
  });

  it("returns post_failed when gh stdout is not JSON", async () => {
    const { runner } = runnerFromScript([{ exitCode: 0, stdout: "not json at all" }]);
    const poster = new GhPrReviewPoster({ runner });

    const review = reviewWith([
      { severity: "P1", title: "x", detail: "y", file: "a", startLine: 1 },
    ]);

    const result = await poster.post(samplePr, review);

    expect(result.outcome).toBe("post_failed");
  });

  it("derives owner/repo from the PR URL", async () => {
    const { runner, invocations } = runnerFromScript([
      { exitCode: 0, stdout: JSON.stringify({ html_url: "https://github.com/x/y/pull/9#r" }) },
    ]);
    const poster = new GhPrReviewPoster({ runner });

    const pr: PullRequestSnapshot = {
      ...samplePr,
      url: "https://github.com/x/y/pull/9",
      number: 9,
    };
    await poster.post(pr, reviewWith([], "ok"));

    expect(invocations[0]?.args).toContain("repos/x/y/pulls/9/reviews");
  });

  it("never includes shippedIssues content (poster has no access to issue text)", async () => {
    const { runner, invocations } = runnerFromScript([
      {
        exitCode: 0,
        stdout: JSON.stringify({ html_url: "https://github.com/org/loom/pull/42#r" }),
      },
    ]);
    const poster = new GhPrReviewPoster({ runner });

    const review = reviewWith(
      [{ severity: "P1", title: "t", detail: "d", file: "src/a.ts", startLine: 1 }],
      "summary",
    );
    await poster.post(samplePr, review);

    const stdin = invocations[0]?.stdin ?? "";
    expect(stdin).not.toMatch(/acceptance criteria/i);
    expect(stdin).not.toMatch(/TEZ-/);
  });
});
