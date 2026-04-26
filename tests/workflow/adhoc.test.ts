import { describe, it, expect, vi } from "vitest";

import { parseProjectConfigRegistry } from "../../src/config/index.js";
import {
  submitAdhocRun,
  type AdhocRunDeps,
  type AdhocSubmitInput,
} from "../../src/workflow/adhoc.js";
import type { SubmitRunResult } from "../../src/workflow/types.js";

const REGISTRY_YAML = `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    linearTeamKey: TEZ
    linearProjectName: loom
    verification:
      commands:
        - name: test
          command: pnpm test
  - slug: bare
    repoRoot: /repos/bare
    defaultBranch: main
    verification:
      commands:
        - name: test
          command: pnpm test
`;

function makeDeps(overrides: Partial<AdhocRunDeps> = {}): AdhocRunDeps {
  return {
    registry: parseProjectConfigRegistry(REGISTRY_YAML, { homeDir: "/Users/test" }),
    linear: {
      findTeamIdByKey: vi.fn(async () => "team-1"),
      findProjectIdByName: vi.fn(async () => "proj-1"),
      findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
      createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
      findBacklogState: vi.fn(async () => ({ id: "state-1" })),
      createIssue: vi.fn(async () => ({
        identifier: "TEZ-100",
        url: "https://linear.app/tez/issue/TEZ-100",
      })),
    },
    engine: {
      submitRun: vi.fn(
        (): SubmitRunResult => ({
          accepted: true,
          run: {
            id: "run-uuid",
            projectSlug: "loom",
            issueId: "TEZ-100",
            source: "adhoc",
            state: "queued",
            failureReason: null,
            revisionCount: 0,
            createdAt: "2026-04-26T00:00:00.000Z",
            updatedAt: "2026-04-26T00:00:00.000Z",
            queuePosition: 1,
            issueSnapshot: null,
            workspace: null,
            attempts: [],
            events: [],
            handoff: null,
          },
          queuePosition: 1,
        }),
      ),
    },
    scheduler: { schedule: vi.fn() },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    ...overrides,
  };
}

const baseInput: AdhocSubmitInput = {
  project: "loom",
  prompt: "Fix the typo in README",
};

describe("submitAdhocRun", () => {
  it("resolves slug, creates a Linear issue, submits a run, and returns the payload", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, baseInput);

    expect(result).toEqual({
      ok: true,
      runId: "run-uuid",
      issueId: "TEZ-100",
      linearUrl: "https://linear.app/tez/issue/TEZ-100",
      queuePosition: 1,
    });
    expect(deps.linear.createIssue).toHaveBeenCalledTimes(1);
    expect(deps.engine.submitRun).toHaveBeenCalledWith({
      projectSlug: "loom",
      issueId: "TEZ-100",
      executionMode: "enqueue",
      source: "adhoc",
    });
    expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it("resolves an absolute repoRoot path to its registered project", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "/repos/loom", prompt: "x" });
    expect(result.ok).toBe(true);
    expect(deps.engine.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: "loom" }),
    );
  });

  it("returns project_not_found when the slug is unknown", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "missing", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "project_not_found",
      projectIdentifier: "missing",
    });
    expect(deps.linear.createIssue).not.toHaveBeenCalled();
    expect(deps.engine.submitRun).not.toHaveBeenCalled();
  });

  it("rejects relative paths as validation_failed", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "./loom", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "validation_failed",
      details: expect.stringMatching(/absolute/i),
    });
  });

  it("returns validation_failed for empty / whitespace-only prompts", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "loom", prompt: "   \n   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
  });

  it("returns validation_failed for prompts longer than 8000 chars", async () => {
    const deps = makeDeps();
    const big = "x".repeat(8001);
    const result = await submitAdhocRun(deps, { project: "loom", prompt: big });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
  });

  it("returns linear_not_configured when the project lacks linearTeamKey or linearProjectName", async () => {
    const deps = makeDeps();
    const result = await submitAdhocRun(deps, { project: "bare", prompt: "x" });
    expect(result).toEqual({
      ok: false,
      error: "linear_not_configured",
      projectSlug: "bare",
      missing: expect.arrayContaining(["linearTeamKey", "linearProjectName"]),
    });
    expect(deps.linear.createIssue).not.toHaveBeenCalled();
  });

  it("maps AdhocIssueError to linear_create_failed with reason", async () => {
    const deps = makeDeps({
      linear: {
        ...makeDeps().linear,
        findBacklogState: vi.fn(async () => null),
      },
    });
    const result = await submitAdhocRun(deps, baseInput);
    expect(result).toEqual({
      ok: false,
      error: "linear_create_failed",
      reason: "missing_backlog_state",
      message: expect.stringContaining("Backlog"),
    });
  });

  it("returns submit_after_create_failed (with orphanedIssueId) if submitRun throws after issue is created", async () => {
    const deps = makeDeps({
      engine: {
        submitRun: vi.fn(() => {
          throw new Error("db unavailable");
        }),
      },
    });
    const result = await submitAdhocRun(deps, baseInput);
    expect(result).toEqual({
      ok: false,
      error: "submit_after_create_failed",
      orphanedIssueId: "TEZ-100",
      message: expect.stringContaining("db unavailable"),
    });
  });

  it("derives title from the first non-empty line truncated at 80 chars and includes the dated footer", async () => {
    const deps = makeDeps();
    const longLine = "x".repeat(120);
    const prompt = `\n\n   \n${longLine}\nMore detail on the next line.`;
    await submitAdhocRun(deps, { project: "loom", prompt });

    const calls = (deps.linear.createIssue as ReturnType<typeof vi.fn>).mock.calls;
    const args = calls[0]?.[0];
    expect(args.title).toBe("x".repeat(80));
    expect(args.description).toBe(prompt + "\n\n_Submitted via Loomforge ad-hoc on 2026-04-26._");
  });
});
