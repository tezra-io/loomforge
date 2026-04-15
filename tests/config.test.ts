import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadProjectConfigRegistry,
  parseOpenClawRunRequest,
  parseProjectConfigRegistry,
} from "../src/config/index.js";

describe("project config registry", () => {
  it("parses YAML registry entries and resolves default Loom runtime paths", () => {
    const registry = parseProjectConfigRegistry(
      `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: unit
          command: pnpm test
        - name: build
          command: pnpm build
          timeoutMs: 120000
    timeouts:
      builderMs: 1800000
      reviewerMs: 600000
      verificationMs: 300000
    review:
      maxRevisionLoops: 2
      blockingSeverities: [P0, P1]
`,
      { homeDir: "/Users/alice" },
    );

    expect(registry.runtime.dataRoot).toBe("/Users/alice/.loom/data");
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]).toMatchObject({
      slug: "loom",
      repoRoot: "/repos/loom",
      defaultBranch: "main",
      worktreeRoot: "/Users/alice/.loom/worktrees/loom",
      runtimeDataRoot: "/Users/alice/.loom/data/projects/loom",
      timeouts: {
        builderMs: 1800000,
        reviewerMs: 600000,
        verificationMs: 300000,
      },
      review: {
        maxRevisionLoops: 2,
        blockingSeverities: ["P0", "P1"],
      },
    });
    expect(registry.projects[0]?.verification.commands).toEqual([
      {
        name: "unit",
        command: "pnpm test",
        timeoutMs: 300000,
      },
      {
        name: "build",
        command: "pnpm build",
        timeoutMs: 120000,
      },
    ]);
    expect(registry.bySlug.get("loom")?.repoRoot).toBe("/repos/loom");
  });

  it("loads a checked-in YAML config file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "loom-config-"));
    const configPath = join(tempRoot, "loom.yaml");
    await mkdir(join(tempRoot, "repo"));
    await writeFile(
      configPath,
      `
runtime:
  dataRoot: .loom-state
projects:
  - slug: sample
    repoRoot: ./repo
    defaultBranch: trunk
    worktreeRoot: ./worktrees/sample
    runtimeDataRoot: ./runtime/sample
    verification:
      commands:
        - name: lint
          command: pnpm lint
`,
      "utf8",
    );

    const registry = await loadProjectConfigRegistry(configPath, {
      homeDir: "/Users/alice",
    });

    expect(registry.runtime.dataRoot).toBe(join(tempRoot, ".loom-state"));
    expect(registry.projects[0]).toMatchObject({
      slug: "sample",
      repoRoot: join(tempRoot, "repo"),
      defaultBranch: "trunk",
      worktreeRoot: join(tempRoot, "worktrees/sample"),
      runtimeDataRoot: join(tempRoot, "runtime/sample"),
    });
  });

  it("rejects malformed registry configs", () => {
    expect(() =>
      parseProjectConfigRegistry(
        `
projects:
  - slug: "not a valid slug"
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands: []
`,
        { homeDir: "/Users/alice" },
      ),
    ).toThrow(/Invalid project config/);

    expect(() =>
      parseProjectConfigRegistry(
        `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: unit
          command: ""
`,
        { homeDir: "/Users/alice" },
      ),
    ).toThrow(/Invalid project config/);
  });

  it("rejects digit-leading and trailing-hyphen project slugs", () => {
    for (const slug of ["1loom", "loom-"]) {
      expect(() =>
        parseProjectConfigRegistry(
          `
projects:
  - slug: ${slug}
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: unit
          command: pnpm test
`,
          { homeDir: "/Users/alice" },
        ),
      ).toThrow(/Invalid project config/);
    }
  });

  it("rejects duplicate project slugs", () => {
    expect(() =>
      parseProjectConfigRegistry(
        `
projects:
  - slug: loom
    repoRoot: /repos/loom
    defaultBranch: main
    verification:
      commands:
        - name: unit
          command: pnpm test
  - slug: loom
    repoRoot: /repos/loom-copy
    defaultBranch: main
    verification:
      commands:
        - name: unit
          command: pnpm test
`,
        { homeDir: "/Users/alice" },
      ),
    ).toThrow(/duplicate project slug/);
  });

  it("rejects verification commands from OpenClaw issue payloads", () => {
    expect(() =>
      parseOpenClawRunRequest({
        projectSlug: "loom",
        issueId: "TEZ-334",
        verification: {
          commands: ["pnpm test -- --runInBand"],
        },
      }),
    ).toThrow(/OpenClaw run requests may only include projectSlug and issueId/);

    expect(
      parseOpenClawRunRequest({
        projectSlug: "loom",
        issueId: "TEZ-334",
      }),
    ).toEqual({
      projectSlug: "loom",
      issueId: "TEZ-334",
    });
  });
});
