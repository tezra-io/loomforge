import pino from "pino";
import { describe, it, expect, vi } from "vitest";

import { createApiServer } from "../../src/api/index.js";
import { createStubWorkflowDependencies } from "../../src/app/index.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";
import type { LinearAdhocClient } from "../../src/linear/index.js";
import { WorkflowEngine } from "../../src/workflow/index.js";

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

function makeAdhocLinear(overrides: Partial<LinearAdhocClient> = {}): LinearAdhocClient {
  return {
    findTeamIdByKey: vi.fn(async () => "team-1"),
    findProjectIdByName: vi.fn(async () => "proj-1"),
    findLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    createLabel: vi.fn(async () => ({ id: "lbl-1", name: "loomforge-adhoc" })),
    findBacklogState: vi.fn(async () => ({ id: "state-1" })),
    createIssue: vi.fn(async () => ({
      identifier: "TEZ-100",
      url: "https://linear.app/tez/issue/TEZ-100",
    })),
    ...overrides,
  };
}

function makeServer(adhocLinear: LinearAdhocClient = makeAdhocLinear()) {
  const registry = parseProjectConfigRegistry(REGISTRY_YAML, { homeDir: "/Users/test" });
  const stub = createStubWorkflowDependencies();
  const engine = new WorkflowEngine({
    registry,
    linear: stub.linear,
    worktrees: stub.worktrees,
    builder: stub.builder,
    reviewer: stub.reviewer,
  });
  let scheduled = 0;
  const scheduler = {
    schedule: () => {
      scheduled += 1;
    },
    drainNow: async () => {
      // no-op
    },
  };
  const server = createApiServer({
    engine,
    scheduler,
    adhocLinear,
    logger: pino({ level: "silent" }),
  });
  return { server, getScheduledCount: () => scheduled };
}

describe("POST /runs/adhoc", () => {
  it("returns 200 with the run + Linear identifiers on the happy path", async () => {
    const { server, getScheduledCount } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "Fix the typo in README" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      runId: expect.any(String),
      issueId: "TEZ-100",
      linearUrl: "https://linear.app/tez/issue/TEZ-100",
      queuePosition: 1,
    });
    expect(getScheduledCount()).toBe(1);
  });

  it("returns 400 validation_failed for an empty prompt", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_failed" });
  });

  it("returns 404 project_not_found for an unknown slug", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "missing", prompt: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: "project_not_found",
      projectIdentifier: "missing",
    });
  });

  it("returns 409 linear_not_configured for a project without linearTeamKey/linearProjectName", async () => {
    const { server } = makeServer();
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "bare", prompt: "x" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "linear_not_configured",
      projectSlug: "bare",
      missing: expect.arrayContaining(["linearTeamKey", "linearProjectName"]),
    });
  });

  it("returns 502 linear_create_failed when issue creation fails", async () => {
    const { server } = makeServer(
      makeAdhocLinear({
        findBacklogState: vi.fn(async () => null),
      }),
    );
    const res = await server.inject({
      method: "POST",
      url: "/runs/adhoc",
      payload: { project: "loom", prompt: "x" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: "linear_create_failed",
      reason: "missing_backlog_state",
    });
  });
});
