import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import type { DesignConfig, ProjectConfig, ProjectConfigRegistry } from "../../src/config/index.js";
import {
  DesignEngine,
  resumeStateFor,
  type DesignEngineOptions,
  type GhRemoteProvider,
} from "../../src/design/engine.js";
import type { DesignBuilderRunner, DesignReviewerRunner } from "../../src/design/engine.js";
import type { DesignRunRecord, DesignRunStore } from "../../src/design/types.js";
import type {
  LinearDesignClient,
  LinearDocumentSummary,
  LinearProjectSummary,
} from "../../src/linear/linear-workflow-client.js";
import type {
  DesignBuilderResult,
  DesignBuilderRunOptions,
  DesignReviewSuccess,
  DesignReviewerRunOptions,
} from "../../src/runners/index.js";

class InMemoryDesignRunStore implements DesignRunStore {
  private readonly runs = new Map<string, DesignRunRecord>();

  upsert(run: DesignRunRecord): void {
    this.runs.set(run.id, { ...run });
  }
  getById(id: string): DesignRunRecord | null {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }
  getByKey(slug: string, feature: string | null): DesignRunRecord | null {
    for (const run of this.runs.values()) {
      if (run.slug === slug && run.feature === feature) return { ...run };
    }
    return null;
  }
  listActive(): DesignRunRecord[] {
    return [...this.runs.values()].map((r) => ({ ...r }));
  }
  listQueued(): DesignRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.queuePosition !== null)
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
      .map((r) => ({ ...r }));
  }
  list(): DesignRunRecord[] {
    return [...this.runs.values()].map((r) => ({ ...r }));
  }
}

interface FakeLinearState {
  nextProjectId: number;
  nextDocId: number;
  projects: Map<string, LinearProjectSummary>;
  docs: Map<string, LinearDocumentSummary & { projectId: string }>;
  projectsById: Map<string, LinearProjectSummary>;
  createProjectCalls: Array<{ teamKey: string; name: string }>;
  createDocCalls: Array<{ projectId: string; title: string; content: string }>;
  updateDocCalls: Array<{ id: string; content: string }>;
}

function createFakeLinear(): {
  client: LinearDesignClient;
  state: FakeLinearState;
} {
  const state: FakeLinearState = {
    nextProjectId: 1,
    nextDocId: 1,
    projects: new Map(),
    docs: new Map(),
    projectsById: new Map(),
    createProjectCalls: [],
    createDocCalls: [],
    updateDocCalls: [],
  };

  const client: LinearDesignClient = {
    async findProjectById(id) {
      return state.projectsById.get(id) ?? null;
    },
    async findProjectsByName(_teamKey, name) {
      const match = state.projects.get(name);
      return match ? [match] : [];
    },
    async createProject(teamKey, name) {
      state.createProjectCalls.push({ teamKey, name });
      const id = `proj-${state.nextProjectId++}`;
      const summary: LinearProjectSummary = {
        id,
        name,
        url: `https://linear.test/project/${id}`,
        archivedAt: null,
      };
      state.projects.set(name, summary);
      state.projectsById.set(id, summary);
      return summary;
    },
    async findDocumentOnProject(projectId, title) {
      const key = `${projectId}::${title}`;
      return state.docs.get(key) ?? null;
    },
    async findDocumentById(id) {
      for (const doc of state.docs.values()) if (doc.id === id) return doc;
      return null;
    },
    async createDocumentOnProject(projectId, title, content) {
      state.createDocCalls.push({ projectId, title, content });
      const id = `doc-${state.nextDocId++}`;
      const summary: LinearDocumentSummary & { projectId: string } = {
        id,
        title,
        url: `https://linear.test/document/${id}`,
        projectId,
      };
      state.docs.set(`${projectId}::${title}`, summary);
      return summary;
    },
    async updateDocument(id, content) {
      state.updateDocCalls.push({ id, content });
      for (const doc of state.docs.values()) {
        if (doc.id === id) return doc;
      }
      throw new Error(`updateDocument: unknown id ${id}`);
    },
  };

  return { client, state };
}

function createFakeBuilder(makeDoc: (path: string) => Promise<void>): {
  runner: DesignBuilderRunner;
  calls: DesignBuilderRunOptions[];
} {
  const calls: DesignBuilderRunOptions[] = [];
  const runner: DesignBuilderRunner = {
    async run(options) {
      calls.push(options);
      const path = options.prompt.designDocPath;
      await mkdir(
        join(path, "..")
          .toString()
          .replace(/\/[^/]*$/, "") || "/tmp",
        {
          recursive: true,
        },
      );
      await makeDoc(path);
      const buf = await readFile(path);
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(buf).digest("hex");
      const result: DesignBuilderResult = {
        outcome: "success",
        designDocPath: path,
        designDocSha256: sha,
        summary: "drafted",
        rawLogPath: "/dev/null",
      };
      return result;
    },
  };
  return { runner, calls };
}

function createFakeReviewer(outcome: DesignReviewSuccess["outcome"] = "pass"): {
  runner: DesignReviewerRunner;
  calls: DesignReviewerRunOptions[];
} {
  const calls: DesignReviewerRunOptions[] = [];
  const runner: DesignReviewerRunner = {
    async run(options) {
      calls.push(options);
      return {
        outcome,
        findings: [],
        summary: "reviewed",
        rawLogPath: "/dev/null",
      };
    },
  };
  return { runner, calls };
}

function buildProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug: "sample",
    repoRoot: "/repos/sample",
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: "ENG",
    linearProjectName: "sample",
    builder: "codex",
    reviewer: "claude",
    runtimeDataRoot: "/runtime",
    verification: { commands: [] },
    timeouts: { builderMs: 1, reviewerMs: 1, verificationMs: 1 },
    review: { maxRevisionLoops: 1, blockingSeverities: ["P0"] },
    linearStatuses: {
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      blocked: "Blocked",
    },
    ...overrides,
  };
}

function buildRegistry(projects: ProjectConfig[] = []): ProjectConfigRegistry {
  return {
    runtime: { dataRoot: "/runtime" },
    projects,
    bySlug: new Map(projects.map((p) => [p.slug, p])),
  };
}

async function setupRepoDir(root: string, slug: string): Promise<string> {
  const repoPath = join(root, slug);
  await mkdir(join(repoPath, "docs", "design"), { recursive: true });
  await execa("git", ["init", "-b", "main"], { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "# existing\n", "utf8");
  await execa("git", ["add", "-A"], { cwd: repoPath });
  await execa("git", ["-c", "user.email=test@x", "-c", "user.name=Test", "commit", "-m", "init"], {
    cwd: repoPath,
  });
  return repoPath;
}

async function writeValidDesignDoc(path: string): Promise<void> {
  await mkdir(join(path, "..").toString(), { recursive: true });
  await writeFile(path, "# Design\n\n" + "x".repeat(400) + "\n", "utf8");
}

interface Harness {
  engine: DesignEngine;
  store: InMemoryDesignRunStore;
  linearState: FakeLinearState;
  builderCalls: DesignBuilderRunOptions[];
  reviewerCalls: DesignReviewerRunOptions[];
  dir: string;
  loomYamlPath: string;
}

async function buildHarness(
  options: {
    registry?: ProjectConfigRegistry;
    designConfig?: DesignConfig | null;
    reviewerOutcome?: DesignReviewSuccess["outcome"];
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "loom-design-engine-"));
  const repoRoot = join(dir, "repos");
  await mkdir(repoRoot, { recursive: true });

  const designConfig: DesignConfig | null =
    options.designConfig === undefined
      ? { repoRoot, defaultBranch: "main", devBranch: "dev", linearTeamKey: "ENG" }
      : options.designConfig;

  const store = new InMemoryDesignRunStore();
  const { client: linear, state: linearState } = createFakeLinear();
  const { runner: builder, calls: builderCalls } = createFakeBuilder(writeValidDesignDoc);
  const { runner: reviewer, calls: reviewerCalls } = createFakeReviewer(
    options.reviewerOutcome ?? "pass",
  );

  const loomYamlPath = join(dir, "loom.yaml");
  const registry = options.registry ?? buildRegistry([]);

  const ghRemote: GhRemoteProvider = async () => ({
    outcome: "skipped",
    reason: "gh_missing",
  });

  const engineOptions: DesignEngineOptions = {
    store,
    linear,
    builder,
    reviewer,
    registry,
    designConfig,
    loomConfigPath: loomYamlPath,
    artifactDir: join(dir, "artifacts"),
    builderTool: "codex",
    reviewerTool: "claude",
    ghRemote,
  };
  const engine = new DesignEngine(engineOptions);

  return { engine, store, linearState, builderCalls, reviewerCalls, dir, loomYamlPath };
}

describe("DesignEngine", () => {
  let harness: Harness;

  afterEach(() => {
    // tmp dirs are left on disk — they do not pollute tests
  });

  it("enqueues on startNew and returns a queued run without executing", async () => {
    harness = await buildHarness();

    const run = await harness.engine.startNew({
      slug: "alpha",
      requirementText: "ship a thing",
    });

    expect(run.state).toBe("queued");
    expect(run.queuePosition).toBe(1);
    expect(harness.builderCalls.length).toBe(0);
    expect(harness.reviewerCalls.length).toBe(0);
  });

  it("drains a queued run through scaffold → build → review → publish → register", async () => {
    harness = await buildHarness();

    const queued = await harness.engine.startNew({
      slug: "alpha",
      requirementText: "ship a thing",
    });

    const drained = await harness.engine.drainNext();
    expect(drained).not.toBeNull();
    if (!drained) return;
    expect(drained.state).toBe("complete");
    expect(drained.queuePosition).toBeNull();
    expect(drained.linearProjectId).toBe("proj-1");
    expect(drained.linearProjectUrl).toBe("https://linear.test/project/proj-1");
    expect(drained.linearDocumentId).toBe("doc-1");
    expect(drained.linearDocumentUrl).toBe("https://linear.test/document/doc-1");

    const persisted = harness.store.getById(queued.id);
    expect(persisted?.state).toBe("complete");
    expect(harness.builderCalls.length).toBe(1);
    expect(harness.reviewerCalls.length).toBe(1);

    const noMore = await harness.engine.drainNext();
    expect(noMore).toBeNull();
  });

  it("cancels a queued run before it executes", async () => {
    harness = await buildHarness();
    const queued = await harness.engine.startNew({
      slug: "alpha",
      requirementText: "hello",
    });

    const cancelled = harness.engine.cancel(queued.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.queuePosition).toBeNull();

    const drained = await harness.engine.drainNext();
    expect(drained).toBeNull();
    expect(harness.builderCalls.length).toBe(0);
  });

  it("drainNext aborts before the builder runs when cancellation arrived after scaffolding", async () => {
    // Use extend flow so scaffolding is a no-op; we cancel between scaffold (skipped) and build.
    const parentDir = await mkdtemp(join(tmpdir(), "loom-design-cancel-"));
    const repoPath = await setupRepoDir(parentDir, "alpha");
    const project = buildProject({ slug: "alpha", repoRoot: repoPath });
    harness = await buildHarness({ registry: buildRegistry([project]) });

    // Replace the builder with one that records and cancels mid-flight so the
    // post-step cancellation check returns the cancelled record.
    let queuedId: string | null = null;
    harness.engine = new DesignEngine({
      store: harness.store,
      linear: (await createAutoLinear()).client,
      builder: {
        async run(options) {
          if (queuedId) {
            harness.engine.cancel(queuedId);
          }
          const buf = "# Design\n\n" + "x".repeat(400) + "\n";
          await writeFile(options.prompt.designDocPath, buf, "utf8");
          const { createHash } = await import("node:crypto");
          return {
            outcome: "success",
            designDocPath: options.prompt.designDocPath,
            designDocSha256: createHash("sha256").update(buf).digest("hex"),
            summary: "drafted",
            rawLogPath: "/dev/null",
          };
        },
      },
      reviewer: {
        async run() {
          throw new Error("reviewer should not run after cancellation");
        },
      },
      registry: buildRegistry([project]),
      designConfig: {
        repoRoot: parentDir,
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: harness.loomYamlPath,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    const queued = await harness.engine.startExtend({
      slug: "alpha",
      feature: "turbo",
      requirementText: "add turbo mode",
    });
    queuedId = queued.id;

    const drained = await harness.engine.drainNext();
    expect(drained?.state).toBe("cancelled");
  });

  it("redraft preserves linearDocumentId so the Linear URL is stable", async () => {
    harness = await buildHarness();

    const queued = await harness.engine.startNew({
      slug: "alpha",
      requirementText: "first pass",
    });
    await harness.engine.drainNext();

    const firstDocId = harness.store.getById(queued.id)?.linearDocumentId;
    expect(firstDocId).toBe("doc-1");

    const reDrafted = await harness.engine.startNew({
      slug: "alpha",
      requirementText: "tighter pass",
      redraft: true,
    });
    expect(reDrafted.linearDocumentId).toBe(firstDocId);
    expect(reDrafted.linearDocumentUrl).toBe("https://linear.test/document/doc-1");
    expect(reDrafted.designDocSha).toBeNull();
    expect(reDrafted.reviewOutcome).toBeNull();

    await harness.engine.drainNext();

    const second = harness.store.getById(reDrafted.id);
    expect(second?.linearDocumentId).toBe(firstDocId);
    expect(harness.linearState.updateDocCalls.length).toBe(1);
    expect(harness.linearState.createDocCalls.length).toBe(1);
  });

  it("rejects requirementPath outside the configured safe roots", async () => {
    harness = await buildHarness();

    await expect(
      harness.engine.startNew({
        slug: "alpha",
        requirementPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/outside the configured safe roots/);
  });

  it("rejects repoRoot outside the configured safe roots", async () => {
    harness = await buildHarness();

    await expect(
      harness.engine.startNew({
        slug: "alpha",
        requirementText: "hi",
        repoRoot: "/tmp/not-in-policy",
      }),
    ).rejects.toThrow(/outside the configured safe roots/);
  });

  it("fails the run when two live Linear projects match the slug", async () => {
    harness = await buildHarness();
    // Seed a conflict: two live projects with the same name.
    const { client: linear, state } = createFakeLinear();
    const originalFind = linear.findProjectsByName.bind(linear);
    linear.findProjectsByName = async (_teamKey, name) => {
      const live: LinearProjectSummary = {
        id: "proj-a",
        name,
        url: "https://linear.test/project/proj-a",
        archivedAt: null,
      };
      const second: LinearProjectSummary = {
        id: "proj-b",
        name,
        url: "https://linear.test/project/proj-b",
        archivedAt: null,
      };
      state.projects.set(name, live);
      return [live, second];
    };
    void originalFind;

    harness.engine = new DesignEngine({
      store: harness.store,
      linear,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: {
        repoRoot: join(harness.dir, "repos"),
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: harness.loomYamlPath,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    await harness.engine.startNew({ slug: "alpha", requirementText: "hi" });
    const drained = await harness.engine.drainNext();
    expect(drained?.state).toBe("failed");
    expect(drained?.failureReason).toBe("design_linear_conflict");
  });

  it("retry after a failed revise re-runs stepReviseBuild instead of publishing the unrevised draft", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-design-revise-retry-"));
    const repoRoot = join(dir, "repos");
    await mkdir(repoRoot, { recursive: true });
    const store = new InMemoryDesignRunStore();
    const { client: linear, state: linearState } = createFakeLinear();

    const builderCalls: Array<{ attemptLabel: string }> = [];
    let reviseAttempt = 0;
    const builder: DesignBuilderRunner = {
      async run(options) {
        builderCalls.push({ attemptLabel: options.attemptLabel });
        if (options.attemptLabel === "design-builder-revision") {
          reviseAttempt += 1;
          if (reviseAttempt === 1) {
            return {
              outcome: "failed",
              failureReason: "runner_error",
              summary: "boom",
              rawLogPath: "/dev/null",
            };
          }
        }
        const buf = "# Design\n\n" + "y".repeat(400) + "\n" + options.attemptLabel;
        await writeValidDesignDoc(options.prompt.designDocPath);
        await writeFile(options.prompt.designDocPath, buf, "utf8");
        const { createHash } = await import("node:crypto");
        return {
          outcome: "success",
          designDocPath: options.prompt.designDocPath,
          designDocSha256: createHash("sha256").update(buf).digest("hex"),
          summary: "drafted",
          rawLogPath: "/dev/null",
        };
      },
    };

    const engine = new DesignEngine({
      store,
      linear,
      builder,
      reviewer: createFakeReviewer("revise").runner,
      registry: buildRegistry([]),
      designConfig: { repoRoot, defaultBranch: "main", devBranch: "dev", linearTeamKey: "ENG" },
      loomConfigPath: join(dir, "loom.yaml"),
      artifactDir: join(dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    const queued = await engine.startNew({ slug: "alpha", requirementText: "hi" });
    const failed = await engine.drainNext();
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toBe("runner_error");
    expect(failed?.reviewOutcome).toBe("revise");
    expect(failed?.revisionApplied).toBe(false);

    await engine.retry(queued.id);
    const retried = await engine.drainNext();
    expect(retried?.state).toBe("complete");
    expect(retried?.revisionApplied).toBe(true);

    const revisionBuilds = builderCalls.filter((c) => c.attemptLabel === "design-builder-revision");
    expect(revisionBuilds.length).toBe(2);
    expect(linearState.createDocCalls.length).toBe(1);
  });

  it("uses the registered linearProjectName for extend runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-design-extend-name-"));
    const repoPath = await setupRepoDir(dir, "alpha");
    const project = buildProject({
      slug: "alpha",
      repoRoot: repoPath,
      linearProjectName: "Alpha Platform",
    });

    const store = new InMemoryDesignRunStore();
    const { client: linear, state: linearState } = createFakeLinear();
    // Seed the existing project under its linearProjectName.
    linearState.projects.set("Alpha Platform", {
      id: "proj-existing",
      name: "Alpha Platform",
      url: "https://linear.test/project/proj-existing",
      archivedAt: null,
    });
    linearState.projectsById.set("proj-existing", {
      id: "proj-existing",
      name: "Alpha Platform",
      url: "https://linear.test/project/proj-existing",
      archivedAt: null,
    });

    const engine = new DesignEngine({
      store,
      linear,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([project]),
      designConfig: {
        repoRoot: dir,
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: join(dir, "loom.yaml"),
      artifactDir: join(dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    await engine.startExtend({
      slug: "alpha",
      feature: "turbo",
      requirementText: "add turbo",
    });
    const drained = await engine.drainNext();
    expect(drained?.state).toBe("complete");
    expect(drained?.linearProjectId).toBe("proj-existing");
    expect(linearState.createProjectCalls.length).toBe(0);
    expect(linearState.createDocCalls[0]?.projectId).toBe("proj-existing");
  });

  it("fails with registration_failed when loom.yaml append fails and reports needs_registration", async () => {
    harness = await buildHarness();
    // Point loomConfigPath at an existing directory — appendLoomYamlProject will fail trying to write.
    const { client: linear } = createFakeLinear();
    // Replace scaffold gh to return created so we have a remoteUrl.
    harness.engine = new DesignEngine({
      store: harness.store,
      linear,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: {
        repoRoot: join(harness.dir, "repos"),
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      // Make the loom.yaml path a directory so writeFile fails.
      loomConfigPath: harness.dir,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({
        outcome: "created",
        remoteUrl: "git@github.com:test/alpha.git",
      }),
    });

    const { buildHandoff } = await import("../../src/design/engine.js");
    await harness.engine.startNew({ slug: "alpha", requirementText: "hi" });
    const drained = await harness.engine.drainNext();
    if (!drained) throw new Error("expected a drained run");
    expect(drained.state).toBe("failed");
    expect(drained.failureReason).toBe("registration_failed");
    expect(drained.registeredAt).toBeNull();
    expect(drained.remoteUrl).toBe("git@github.com:test/alpha.git");

    const handoff = buildHandoff(drained, []);
    expect(handoff.registration).toBe("needs_registration");
  });

  it("rejects requirement paths with disallowed extensions and hidden segments", async () => {
    harness = await buildHarness();

    await expect(
      harness.engine.startNew({
        slug: "alpha",
        requirementPath: join(harness.dir, "repos", "req.json"),
      }),
    ).rejects.toThrow(/must end in \.md or \.txt/);

    await expect(
      harness.engine.startNew({
        slug: "alpha",
        requirementPath: join(harness.dir, "repos", ".hidden", "req.md"),
      }),
    ).rejects.toThrow(/must not contain hidden segments/);
  });

  it("recovers non-terminal design runs to the queue on startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-design-recover-"));
    const repoRoot = join(dir, "repos");
    await mkdir(repoRoot, { recursive: true });

    const store = new InMemoryDesignRunStore();
    const now = Date.now();
    store.upsert({
      id: "run-existing",
      slug: "beta",
      feature: null,
      kind: "new",
      state: "drafting",
      createdAt: now,
      updatedAt: now,
      requirement: { source: "text", ref: "hi" },
      repoPath: join(repoRoot, "beta"),
      remoteUrl: null,
      designDocPath: null,
      designDocSha: null,
      linearProjectId: null,
      linearProjectUrl: null,
      linearDocumentId: null,
      linearDocumentUrl: null,
      reviewOutcome: null,
      reviewFindings: null,
      revisionApplied: false,
      registeredAt: null,
      failureReason: "runner_error",
      queuePosition: null,
      completedAt: null,
    });

    const engine = new DesignEngine({
      store,
      linear: createFakeLinear().client,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: { repoRoot, defaultBranch: "main", devBranch: "dev", linearTeamKey: "ENG" },
      loomConfigPath: join(dir, "loom.yaml"),
      artifactDir: join(dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    const recovered = store.getById("run-existing");
    expect(recovered?.state).toBe("queued");
    expect(recovered?.queuePosition).toBe(1);
    expect(recovered?.failureReason).toBeNull();

    const drained = await engine.drainNext();
    expect(drained?.id).toBe("run-existing");
    expect(drained?.state).toBe("complete");
  });

  it("forwards design.githubOrg to the gh remote provider", async () => {
    const calls: Array<{ repoPath: string; slug: string; org: string | null }> = [];
    harness = await buildHarness();
    harness.engine = new DesignEngine({
      store: harness.store,
      linear: createFakeLinear().client,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: {
        repoRoot: join(harness.dir, "repos"),
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
        githubOrg: "tezra-io",
      },
      loomConfigPath: harness.loomYamlPath,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async (repoPath, slug, org) => {
        calls.push({ repoPath, slug, org: org ?? null });
        return { outcome: "skipped", reason: "gh_missing" };
      },
    });

    await harness.engine.startNew({ slug: "alpha", requirementText: "ship a thing" });
    await harness.engine.drainNext();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slug).toBe("alpha");
    expect(calls[0]?.org).toBe("tezra-io");
  });

  it("logs each state transition at info level during a happy-path drain", async () => {
    type LogEntry = { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string };
    const entries: LogEntry[] = [];
    const logger = {
      info: (obj: Record<string, unknown>, msg: string) =>
        entries.push({ level: "info", obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) =>
        entries.push({ level: "warn", obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) =>
        entries.push({ level: "error", obj, msg }),
    };

    harness = await buildHarness();
    harness.engine = new DesignEngine({
      store: harness.store,
      linear: createFakeLinear().client,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: {
        repoRoot: join(harness.dir, "repos"),
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: harness.loomYamlPath,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
      logger,
    });

    await harness.engine.startNew({ slug: "alpha", requirementText: "ship a thing" });
    await harness.engine.drainNext();

    const transitions = entries
      .filter((e) => e.level === "info" && e.msg.startsWith("design run "))
      .map((e) => e.msg);
    expect(transitions).toContain("design run queued → scaffolding");
    expect(transitions).toContain("design run scaffolding → drafting");
    expect(transitions).toContain("design run drafting → reviewing");
    expect(transitions).toContain("design run reviewing → publishing");
    expect(transitions).toContain("design run publishing → registering");
    expect(transitions).toContain("design run registering → complete");
  });

  it("uses the registered project's linearTeamKey for extend runs, not the global default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-design-extend-team-"));
    const repoPath = await setupRepoDir(dir, "alpha");
    const project = buildProject({
      slug: "alpha",
      repoRoot: repoPath,
      linearTeamKey: "OTHER",
      linearProjectName: "alpha",
    });

    const store = new InMemoryDesignRunStore();
    const { client: linear } = createFakeLinear();
    const findCalls: Array<{ teamKey: string; name: string }> = [];
    linear.findProjectsByName = async (teamKey, name) => {
      findCalls.push({ teamKey, name });
      return [];
    };

    const engine = new DesignEngine({
      store,
      linear,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([project]),
      designConfig: {
        repoRoot: dir,
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: join(dir, "loom.yaml"),
      artifactDir: join(dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({ outcome: "skipped", reason: "gh_missing" }),
    });

    await engine.startExtend({
      slug: "alpha",
      feature: "turbo",
      requirementText: "add turbo",
    });
    await engine.drainNext();

    expect(findCalls.length).toBeGreaterThanOrEqual(1);
    expect(findCalls[0]?.teamKey).toBe("OTHER");
  });

  it("setRegistry makes a freshly registered project available to startExtend", async () => {
    harness = await buildHarness();

    await expect(
      harness.engine.startExtend({
        slug: "kayak",
        feature: "search",
        requirementText: "add search",
      }),
    ).rejects.toThrow(/not registered in loom\.yaml/);

    const project = buildProject({ slug: "kayak", repoRoot: join(harness.dir, "repos", "kayak") });
    harness.engine.setRegistry(buildRegistry([project]));

    const run = await harness.engine.startExtend({
      slug: "kayak",
      feature: "search",
      requirementText: "add search",
    });
    expect(run.state).toBe("queued");
    expect(run.slug).toBe("kayak");
    expect(run.feature).toBe("search");
  });

  it("fires onProjectRegistered after the register step appends to loom.yaml", async () => {
    const reloadCalls: number[] = [];
    harness = await buildHarness();
    harness.engine = new DesignEngine({
      store: harness.store,
      linear: createFakeLinear().client,
      builder: createFakeBuilder(writeValidDesignDoc).runner,
      reviewer: createFakeReviewer("pass").runner,
      registry: buildRegistry([]),
      designConfig: {
        repoRoot: join(harness.dir, "repos"),
        defaultBranch: "main",
        devBranch: "dev",
        linearTeamKey: "ENG",
      },
      loomConfigPath: harness.loomYamlPath,
      artifactDir: join(harness.dir, "artifacts"),
      builderTool: "codex",
      reviewerTool: "claude",
      ghRemote: async () => ({
        outcome: "created",
        remoteUrl: "https://github.com/example/alpha.git",
      }),
      onProjectRegistered: async () => {
        reloadCalls.push(Date.now());
      },
    });

    await harness.engine.startNew({ slug: "alpha", requirementText: "ship a thing" });
    const drained = await harness.engine.drainNext();

    expect(drained?.state).toBe("complete");
    expect(reloadCalls).toHaveLength(1);
  });
});

async function createAutoLinear(): Promise<ReturnType<typeof createFakeLinear>> {
  return createFakeLinear();
}

describe("resumeStateFor", () => {
  function baseRun(overrides: Partial<DesignRunRecord> = {}): DesignRunRecord {
    const now = Date.now();
    return {
      id: "r1",
      slug: "alpha",
      feature: null,
      kind: "new",
      state: "queued",
      createdAt: now,
      updatedAt: now,
      requirement: { source: "text", ref: "build a thing" },
      repoPath: "/repos/alpha",
      remoteUrl: null,
      designDocPath: null,
      designDocSha: null,
      reviewOutcome: null,
      reviewFindings: null,
      revisionApplied: false,
      linearProjectId: null,
      linearProjectUrl: null,
      linearDocumentId: null,
      linearDocumentUrl: null,
      registeredAt: null,
      failureReason: null,
      queuePosition: null,
      completedAt: null,
      ...overrides,
    };
  }

  it("resumes at publishing once the revision has been applied, even if Linear publish failed", () => {
    const run = baseRun({
      designDocSha: "sha-1",
      designDocPath: "/repos/alpha/docs/design/alpha-design.md",
      reviewOutcome: "revise",
      revisionApplied: true,
      linearProjectId: null,
    });

    expect(resumeStateFor(run)).toBe("publishing");
  });

  it("still resumes at revising when the revision has not been applied yet", () => {
    const run = baseRun({
      designDocSha: "sha-1",
      designDocPath: "/repos/alpha/docs/design/alpha-design.md",
      reviewOutcome: "revise",
      revisionApplied: false,
      linearProjectId: null,
    });

    expect(resumeStateFor(run)).toBe("revising");
  });
});
