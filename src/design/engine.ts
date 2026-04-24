import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DesignConfig, ProjectConfigRegistry } from "../config/index.js";
import type { LinearDesignClient } from "../linear/linear-workflow-client.js";
import type {
  DesignBuilderResult,
  DesignBuilderRunOptions,
  DesignReviewSuccess,
  DesignReviewerRunOptions,
} from "../runners/index.js";
import type { EngineLogger, ReviewFinding } from "../workflow/types.js";
import { ensureGithubRemote, type GhRemoteResult } from "../scaffolding/gh-remote.js";
import { designTemplatePath } from "../scaffolding/paths.js";
import { ensureScaffold, type ScaffoldOptions } from "../scaffolding/scaffold.js";
import {
  appendLoomYamlProject,
  defaultVerificationPlaceholder,
  type LoomYamlProjectEntry,
} from "./loom-yaml-appender.js";
import {
  assertRepoRootAllowed,
  assertRequirementPathAllowed,
  buildDesignPathPolicy,
  type DesignPathPolicy,
} from "./path-policy.js";
import { assertAllowedRequirementPath, loadRequirementMarkdown } from "./requirement.js";
import {
  isDesignTerminalState,
  type DesignExtendInput,
  type DesignFailureReason,
  type DesignHandoff,
  type DesignNewInput,
  type DesignRequirement,
  type DesignReviewOutcome,
  type DesignRunKind,
  type DesignRunRecord,
  type DesignRunState,
  type DesignRunStore,
} from "./types.js";
import { assertRequirement, assertValidSlug } from "./validation.js";

const noopLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_BUILDER_TIMEOUT_MS = 1_800_000;
const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000;

export interface DesignBuilderRunner {
  run(options: DesignBuilderRunOptions): Promise<DesignBuilderResult>;
}

export interface DesignReviewerRunner {
  run(options: DesignReviewerRunOptions): Promise<DesignReviewSuccess>;
}

export type GhRemoteProvider = (
  repoPath: string,
  slug: string,
  org?: string | null,
) => Promise<GhRemoteResult>;

export interface DesignEngineOptions {
  store: DesignRunStore;
  linear: LinearDesignClient;
  builder: DesignBuilderRunner;
  reviewer: DesignReviewerRunner;
  registry: ProjectConfigRegistry;
  designConfig: DesignConfig | null;
  loomConfigPath: string;
  artifactDir: string;
  builderTool: "codex" | "claude";
  reviewerTool: "codex" | "claude";
  builderTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  logger?: EngineLogger;
  newId?: () => string;
  now?: () => number;
  ghRemote?: GhRemoteProvider;
  onProjectRegistered?: () => void | Promise<void>;
}

interface StepContext {
  run: DesignRunRecord;
  project: ProjectConfigContext;
  designConfig: DesignConfig;
  requirementMarkdown: string;
}

interface ProjectConfigContext {
  slug: string;
  linearProjectName: string;
  repoPath: string;
  defaultBranch: string;
  devBranch: string;
  linearTeamKey: string;
}

export class DesignEngine {
  private readonly options: DesignEngineOptions;
  private readonly log: EngineLogger;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  private pathPolicy: DesignPathPolicy;
  private readonly ghRemote: GhRemoteProvider;

  constructor(options: DesignEngineOptions) {
    this.options = options;
    this.log = options.logger ?? noopLogger;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => Date.now());
    this.ghRemote = options.ghRemote ?? ensureGithubRemote;
    this.pathPolicy = this.buildPathPolicy();
    this.recoverPersistedRuns();
  }

  setRegistry(registry: ProjectConfigRegistry): void {
    this.options.registry = registry;
    this.pathPolicy = this.buildPathPolicy();
  }

  private buildPathPolicy(): DesignPathPolicy {
    const repoRoots = Array.from(
      new Set(
        this.options.registry.projects.map((p) => p.repoRoot).filter((r): r is string => !!r),
      ),
    );
    return buildDesignPathPolicy(this.options.designConfig?.repoRoot ?? null, {
      repoRoots,
    });
  }

  private recoverPersistedRuns(): void {
    for (const run of this.options.store.listActive()) {
      if (isDesignTerminalState(run.state)) continue;
      const restored: DesignRunRecord = {
        ...run,
        state: "queued",
        queuePosition: run.queuePosition ?? this.nextQueuePosition(run.id),
        failureReason: null,
        updatedAt: this.now(),
      };
      this.options.store.upsert(restored);
      this.log.info(
        { runId: run.id, previousState: run.state },
        "recovered design run to queue on startup",
      );
    }
  }

  private nextQueuePosition(excludeId: string): number {
    const queued = this.options.store.listQueued();
    const highest = queued.reduce(
      (acc, r) =>
        r.id !== excludeId && r.queuePosition !== null ? Math.max(acc, r.queuePosition) : acc,
      0,
    );
    return highest + 1;
  }

  async startNew(input: DesignNewInput): Promise<DesignRunRecord> {
    assertValidSlug(input.slug, "slug");
    assertRequirement(input.requirementPath, input.requirementText);
    const design = this.requireDesignConfig();

    const repoRoot = resolve(input.repoRoot ?? design.repoRoot);
    assertRepoRootAllowed(this.pathPolicy, repoRoot);
    if (input.requirementPath) {
      assertRequirementPathAllowed(this.pathPolicy, input.requirementPath);
      assertAllowedRequirementPath(input.requirementPath);
    }

    const repoPath = join(repoRoot, input.slug);
    const requirement = buildRequirement(input.requirementPath, input.requirementText);

    const existing = this.options.store.getByKey(input.slug, null);
    const base = existing
      ? this.reconcileRun(existing, requirement, repoPath, Boolean(input.redraft))
      : this.createNewRun("new", input.slug, null, requirement, repoPath);

    const queued = this.enqueue(base);
    this.persist(queued);
    return queued;
  }

  async startExtend(input: DesignExtendInput): Promise<DesignRunRecord> {
    assertValidSlug(input.slug, "slug");
    assertValidSlug(input.feature, "feature");
    assertRequirement(input.requirementPath, input.requirementText);

    const registered = this.options.registry.bySlug.get(input.slug);
    if (!registered) {
      throw new Error(
        `Project "${input.slug}" is not registered in loom.yaml — use 'design new' first`,
      );
    }

    if (input.requirementPath) {
      assertRequirementPathAllowed(this.pathPolicy, input.requirementPath);
      assertAllowedRequirementPath(input.requirementPath);
    }

    const requirement = buildRequirement(input.requirementPath, input.requirementText);
    const existing = this.options.store.getByKey(input.slug, input.feature);
    const base = existing
      ? this.reconcileRun(existing, requirement, registered.repoRoot, Boolean(input.redraft))
      : this.createNewRun("extend", input.slug, input.feature, requirement, registered.repoRoot);

    const queued = this.enqueue(base);
    this.persist(queued);
    return queued;
  }

  async retry(id: string): Promise<DesignRunRecord> {
    const run = this.options.store.getById(id);
    if (!run) {
      throw new Error(`Unknown design run: ${id}`);
    }
    if (run.state === "complete") return run;
    if (run.state === "cancelled") {
      throw new Error(`Design run ${id} is cancelled; start a new run instead`);
    }
    const queued = this.enqueue({
      ...run,
      failureReason: null,
      updatedAt: this.now(),
    });
    this.persist(queued);
    return queued;
  }

  cancel(id: string): DesignRunRecord {
    const run = this.options.store.getById(id);
    if (!run) {
      throw new Error(`Unknown design run: ${id}`);
    }
    if (run.state === "complete" || run.state === "cancelled") {
      return run;
    }
    const cancelled: DesignRunRecord = {
      ...run,
      state: "cancelled",
      failureReason: "operator_cancel",
      queuePosition: null,
      updatedAt: this.now(),
      completedAt: this.now(),
    };
    this.persist(cancelled);
    return cancelled;
  }

  get(id: string): DesignRunRecord | null {
    return this.options.store.getById(id);
  }

  list(): DesignRunRecord[] {
    return this.options.store.list();
  }

  getStatusForProject(slug: string): {
    slug: string;
    hasRun: boolean;
    latest: DesignRunRecord | null;
    features: DesignRunRecord[];
  } {
    const all = this.options.store.list().filter((r) => r.slug === slug);
    if (all.length === 0) {
      return { slug, hasRun: false, latest: null, features: [] };
    }
    const latest = all.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    return { slug, hasRun: true, latest, features: all };
  }

  async drainNext(): Promise<DesignRunRecord | null> {
    if (this.inFlight.size > 0) return null;

    const queued = this.options.store.listQueued();
    const head = queued[0];
    if (!head) return null;

    const activated = this.activateFromQueue(head);
    this.persist(activated);
    return this.execute(activated);
  }

  private activateFromQueue(run: DesignRunRecord): DesignRunRecord {
    const nextState = resumeStateFor(run);
    if (run.state !== nextState) {
      this.log.info(
        { runId: run.id, slug: run.slug, feature: run.feature, from: run.state, to: nextState },
        `design run ${run.state} → ${nextState}`,
      );
    }
    return {
      ...run,
      state: nextState,
      queuePosition: null,
      updatedAt: this.now(),
    };
  }

  private enqueue(run: DesignRunRecord): DesignRunRecord {
    if (run.queuePosition !== null && run.state === "queued") {
      return run;
    }
    return {
      ...run,
      state: "queued",
      queuePosition: this.nextQueuePosition(run.id),
      updatedAt: this.now(),
    };
  }

  private async execute(initial: DesignRunRecord): Promise<DesignRunRecord> {
    if (this.inFlight.has(initial.id)) {
      return initial;
    }
    this.inFlight.add(initial.id);
    try {
      const design = this.requireDesignConfig();
      const registered =
        initial.kind === "extend" ? this.options.registry.bySlug.get(initial.slug) : null;
      const linearProjectName = registered?.linearProjectName ?? initial.slug;
      const project: ProjectConfigContext = {
        slug: initial.slug,
        linearProjectName,
        repoPath: initial.repoPath ?? "",
        defaultBranch: design.defaultBranch,
        devBranch: design.devBranch,
        linearTeamKey: registered?.linearTeamKey ?? design.linearTeamKey,
      };
      const requirementMarkdown = await loadRequirementMarkdown(initial.requirement);
      const ctx: StepContext = {
        run: initial,
        project,
        designConfig: design,
        requirementMarkdown,
      };

      return await this.runStateMachine(ctx, initial);
    } catch (error) {
      const cancelled = this.readIfCancelled(initial.id);
      if (cancelled) return cancelled;
      const failed = this.transition(initial, {
        state: "failed",
        failureReason: "runner_error",
      });
      this.persist(failed);
      this.log.error(
        { runId: initial.id, error: error instanceof Error ? error.message : String(error) },
        "design run execution failed",
      );
      return failed;
    } finally {
      this.inFlight.delete(initial.id);
    }
  }

  private async runStateMachine(
    ctx: StepContext,
    start: DesignRunRecord,
  ): Promise<DesignRunRecord> {
    let run = start;
    ctx.run = run;

    if (run.kind === "new") {
      const preScaffold = this.readIfCancelled(run.id);
      if (preScaffold) return preScaffold;

      run = this.transition(run, { state: "scaffolding" });
      this.persist(run);

      const scaffoldResult = await this.stepScaffold(run, ctx.project, ctx.designConfig);
      const afterScaffold = this.readIfCancelled(run.id);
      if (afterScaffold) return afterScaffold;

      if (scaffoldResult.outcome === "failed") {
        const failed = this.transition(scaffoldResult.run, {
          state: "failed",
          failureReason: "scaffolding_failed",
        });
        this.persist(failed);
        return failed;
      }
      run = scaffoldResult.run;
      ctx.project.repoPath = run.repoPath ?? ctx.project.repoPath;
      ctx.run = run;
    } else {
      ctx.project.repoPath = run.repoPath ?? ctx.project.repoPath;
    }

    if (!run.designDocSha) {
      const preBuild = this.readIfCancelled(run.id);
      if (preBuild) return preBuild;

      run = this.transition(run, { state: "drafting" });
      this.persist(run);

      const builderOutcome = await this.stepBuild(run, ctx);
      const afterBuild = this.readIfCancelled(run.id);
      if (afterBuild) return afterBuild;

      if (builderOutcome.outcome === "failed") {
        const failed = this.transition(builderOutcome.run, {
          state: "failed",
          failureReason: builderOutcome.failureReason,
        });
        this.persist(failed);
        return failed;
      }
      run = builderOutcome.run;
      ctx.run = run;
    }

    if (!run.reviewOutcome) {
      const preReview = this.readIfCancelled(run.id);
      if (preReview) return preReview;

      run = this.transition(run, { state: "reviewing" });
      this.persist(run);

      const reviewOutcome = await this.stepReview(run, ctx);
      const afterReview = this.readIfCancelled(run.id);
      if (afterReview) return afterReview;

      run = reviewOutcome.run;
      ctx.run = run;

      if (run.reviewOutcome === "blocked") {
        const failed = this.transition(run, {
          state: "failed",
          failureReason: "design_review_blocked",
        });
        this.persist(failed);
        return failed;
      }
    }

    if (run.reviewOutcome === "revise" && !run.revisionApplied) {
      const preRevise = this.readIfCancelled(run.id);
      if (preRevise) return preRevise;

      run = this.transition(run, { state: "revising" });
      this.persist(run);

      const revised = await this.stepReviseBuild(run, ctx);
      const afterRevise = this.readIfCancelled(run.id);
      if (afterRevise) return afterRevise;

      if (revised.outcome === "failed") {
        const failed = this.transition(revised.run, {
          state: "failed",
          failureReason: revised.failureReason,
        });
        this.persist(failed);
        return failed;
      }
      run = revised.run;
      ctx.run = run;
    }

    {
      const prePublish = this.readIfCancelled(run.id);
      if (prePublish) return prePublish;

      run = this.transition(run, { state: "publishing" });
      this.persist(run);

      const publish = await this.stepPublish(run, ctx);
      const afterPublish = this.readIfCancelled(run.id);
      if (afterPublish) return afterPublish;

      if (publish.outcome === "failed") {
        const failed = this.transition(publish.run, {
          state: "failed",
          failureReason: publish.failureReason,
        });
        this.persist(failed);
        return failed;
      }
      run = publish.run;
      ctx.run = run;
    }

    if (run.kind === "new") {
      const preRegister = this.readIfCancelled(run.id);
      if (preRegister) return preRegister;

      run = this.transition(run, { state: "registering" });
      this.persist(run);

      const registerResult = await this.stepRegister(run, ctx);
      const afterRegister = this.readIfCancelled(run.id);
      if (afterRegister) return afterRegister;

      if (registerResult.outcome === "failed") {
        const failed = this.transition(registerResult.run, {
          state: "failed",
          failureReason: "registration_failed",
        });
        this.persist(failed);
        return failed;
      }
      run = registerResult.run;
      ctx.run = run;
    }

    const completed = this.transition(run, { state: "complete" });
    const finalRun: DesignRunRecord = { ...completed, completedAt: this.now() };
    this.persist(finalRun);
    return finalRun;
  }

  private readIfCancelled(runId: string): DesignRunRecord | null {
    const latest = this.options.store.getById(runId);
    if (latest && latest.state === "cancelled") return latest;
    return null;
  }

  private async stepScaffold(
    run: DesignRunRecord,
    project: ProjectConfigContext,
    designConfig: DesignConfig,
  ): Promise<{ outcome: "success" | "failed"; run: DesignRunRecord }> {
    const designDocRelative = designDocRelativePath(run);
    const scaffoldOptions: ScaffoldOptions = {
      repoPath: project.repoPath,
      slug: run.slug,
      designDocRelativePath: designDocRelative,
      defaultBranch: project.defaultBranch,
    };
    const scaffoldResult = await ensureScaffold(scaffoldOptions);
    if (scaffoldResult.outcome === "failed") {
      this.log.error(
        { runId: run.id, reason: scaffoldResult.reason, summary: scaffoldResult.summary },
        "design scaffold failed",
      );
      return { outcome: "failed", run: { ...run, updatedAt: this.now() } };
    }

    let updated: DesignRunRecord = {
      ...run,
      repoPath: project.repoPath,
      updatedAt: this.now(),
    };

    const ghResult = await this.ghRemote(project.repoPath, run.slug, designConfig.githubOrg);
    if (ghResult.outcome === "created") {
      updated = { ...updated, remoteUrl: ghResult.remoteUrl, updatedAt: this.now() };
    } else if (ghResult.outcome === "skipped" && ghResult.reason === "already_has_remote") {
      const remoteUrl = await readRemoteUrlSafe(project.repoPath);
      if (remoteUrl) {
        updated = { ...updated, remoteUrl, updatedAt: this.now() };
      }
    } else if (ghResult.outcome === "failed") {
      this.log.error({ runId: run.id, reason: ghResult.reason }, "github remote creation failed");
      return { outcome: "failed", run: updated };
    }
    return { outcome: "success", run: updated };
  }

  private async stepBuild(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<
    | { outcome: "success"; run: DesignRunRecord }
    | { outcome: "failed"; run: DesignRunRecord; failureReason: DesignFailureReason }
  > {
    const designDocRelative = designDocRelativePath(run);
    const designDocAbsolute = join(ctx.project.repoPath, designDocRelative);

    const result = await this.options.builder.run({
      runId: run.id,
      attemptLabel: "design-builder",
      tool: this.options.builderTool,
      timeoutMs: this.options.builderTimeoutMs ?? DEFAULT_BUILDER_TIMEOUT_MS,
      artifactDir: this.options.artifactDir,
      prompt: {
        slug: run.slug,
        feature: run.feature,
        kind: run.kind,
        repoPath: ctx.project.repoPath,
        designDocPath: designDocAbsolute,
        designTemplatePath: designTemplatePath(),
        requirementMarkdown: ctx.requirementMarkdown,
      },
    });

    if (result.outcome === "failed") {
      return {
        outcome: "failed",
        run: { ...run, updatedAt: this.now() },
        failureReason: result.failureReason,
      };
    }

    return {
      outcome: "success",
      run: {
        ...run,
        designDocPath: result.designDocPath,
        designDocSha: result.designDocSha256,
        updatedAt: this.now(),
      },
    };
  }

  private async stepReview(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<{ run: DesignRunRecord }> {
    if (!run.designDocPath) {
      throw new Error("Review step requires designDocPath");
    }

    const result = await this.options.reviewer.run({
      runId: run.id,
      attemptLabel: "design-reviewer",
      cwd: ctx.project.repoPath,
      tool: this.options.reviewerTool,
      timeoutMs: this.options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
      artifactDir: this.options.artifactDir,
      prompt: {
        slug: run.slug,
        feature: run.feature,
        designDocPath: run.designDocPath,
        designTemplatePath: designTemplatePath(),
        requirementMarkdown: ctx.requirementMarkdown,
      },
    });

    return {
      run: {
        ...run,
        reviewOutcome: result.outcome as DesignReviewOutcome,
        reviewFindings: result.findings,
        updatedAt: this.now(),
      },
    };
  }

  private async stepReviseBuild(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<
    | { outcome: "success"; run: DesignRunRecord }
    | { outcome: "failed"; run: DesignRunRecord; failureReason: DesignFailureReason }
  > {
    const designDocRelative = designDocRelativePath(run);
    const designDocAbsolute = join(ctx.project.repoPath, designDocRelative);
    const findings: ReviewFinding[] = run.reviewFindings ?? [];

    const result = await this.options.builder.run({
      runId: run.id,
      attemptLabel: "design-builder-revision",
      tool: this.options.builderTool,
      timeoutMs: this.options.builderTimeoutMs ?? DEFAULT_BUILDER_TIMEOUT_MS,
      artifactDir: this.options.artifactDir,
      prompt: {
        slug: run.slug,
        feature: run.feature,
        kind: run.kind,
        repoPath: ctx.project.repoPath,
        designDocPath: designDocAbsolute,
        designTemplatePath: designTemplatePath(),
        requirementMarkdown: ctx.requirementMarkdown,
        revisionFindings: findings,
        revisionSummary: "Apply reviewer findings and rewrite the affected sections.",
      },
    });

    if (result.outcome === "failed") {
      return {
        outcome: "failed",
        run: { ...run, updatedAt: this.now() },
        failureReason: result.failureReason,
      };
    }

    return {
      outcome: "success",
      run: {
        ...run,
        designDocSha: result.designDocSha256,
        designDocPath: result.designDocPath,
        revisionApplied: true,
        updatedAt: this.now(),
      },
    };
  }

  private async stepPublish(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<
    | { outcome: "success"; run: DesignRunRecord }
    | { outcome: "failed"; run: DesignRunRecord; failureReason: DesignFailureReason }
  > {
    if (!run.designDocPath) {
      throw new Error("Publish step requires designDocPath");
    }
    const content = await readFile(run.designDocPath, "utf8");

    let updated = run;

    if (!updated.linearProjectId) {
      const projectResult = await this.resolveOrCreateProject(updated, ctx);
      if (projectResult.outcome === "failed") {
        return {
          outcome: "failed",
          run: { ...updated, updatedAt: this.now() },
          failureReason: projectResult.failureReason,
        };
      }
      updated = {
        ...updated,
        linearProjectId: projectResult.projectId,
        linearProjectUrl: projectResult.projectUrl,
        updatedAt: this.now(),
      };
      this.persist(updated);
    }

    if (!updated.linearProjectId) {
      return {
        outcome: "failed",
        run: updated,
        failureReason: "design_linear_conflict",
      };
    }

    const docTitle = documentTitle(updated);

    if (updated.linearDocumentId) {
      try {
        const doc = await this.options.linear.updateDocument(updated.linearDocumentId, content);
        updated = {
          ...updated,
          linearDocumentUrl: doc.url,
          updatedAt: this.now(),
        };
        this.persist(updated);
      } catch (error) {
        this.log.error(
          {
            runId: updated.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "linear document update failed",
        );
        return {
          outcome: "failed",
          run: updated,
          failureReason: "registration_failed",
        };
      }
      return { outcome: "success", run: updated };
    }

    try {
      const existing = await this.options.linear.findDocumentOnProject(
        updated.linearProjectId,
        docTitle,
      );
      if (existing) {
        return {
          outcome: "failed",
          run: {
            ...updated,
            updatedAt: this.now(),
          },
          failureReason: "design_document_conflict",
        };
      }
      const created = await this.options.linear.createDocumentOnProject(
        updated.linearProjectId,
        docTitle,
        content,
      );
      updated = {
        ...updated,
        linearDocumentId: created.id,
        linearDocumentUrl: created.url,
        updatedAt: this.now(),
      };
      this.persist(updated);
    } catch (error) {
      this.log.error(
        {
          runId: updated.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "linear document create failed",
      );
      return {
        outcome: "failed",
        run: updated,
        failureReason: "registration_failed",
      };
    }

    return { outcome: "success", run: updated };
  }

  private async resolveOrCreateProject(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<
    | { outcome: "success"; projectId: string; projectUrl: string }
    | { outcome: "failed"; failureReason: DesignFailureReason }
  > {
    const linear = this.options.linear;
    const teamKey = ctx.project.linearTeamKey;
    const desiredName = ctx.project.linearProjectName;

    try {
      const matches = await linear.findProjectsByName(teamKey, desiredName);
      const live = matches.filter((m) => m.archivedAt === null);
      if (matches.some((m) => m.archivedAt !== null)) {
        return { outcome: "failed", failureReason: "design_linear_conflict" };
      }
      if (live.length > 1) {
        return { outcome: "failed", failureReason: "design_linear_conflict" };
      }
      if (live.length === 1) {
        const only = live[0];
        if (only) {
          return { outcome: "success", projectId: only.id, projectUrl: only.url };
        }
      }

      if (run.kind === "extend") {
        return { outcome: "failed", failureReason: "project_not_found" };
      }

      const created = await linear.createProject(teamKey, desiredName, null);
      return { outcome: "success", projectId: created.id, projectUrl: created.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("team not found")) {
        return { outcome: "failed", failureReason: "linear_team_missing" };
      }
      this.log.error({ runId: run.id, error: message }, "linear project resolution failed");
      return { outcome: "failed", failureReason: "registration_failed" };
    }
  }

  private async stepRegister(
    run: DesignRunRecord,
    ctx: StepContext,
  ): Promise<{ outcome: "success" | "failed"; run: DesignRunRecord }> {
    if (!run.remoteUrl) {
      return { outcome: "success", run: { ...run, updatedAt: this.now() } };
    }

    const entry: LoomYamlProjectEntry = {
      slug: run.slug,
      repoRoot: ctx.project.repoPath,
      defaultBranch: ctx.designConfig.defaultBranch,
      devBranch: ctx.designConfig.devBranch,
      linearTeamKey: ctx.designConfig.linearTeamKey,
      linearProjectName: ctx.project.linearProjectName,
      builder: this.options.builderTool,
      reviewer: this.options.reviewerTool,
      verification: defaultVerificationPlaceholder(),
    };

    const result = await appendLoomYamlProject(this.options.loomConfigPath, entry);
    if (result.outcome === "failed") {
      this.log.error(
        { runId: run.id, path: this.options.loomConfigPath, summary: result.summary },
        "loom.yaml append failed",
      );
      return { outcome: "failed", run: { ...run, updatedAt: this.now() } };
    }
    if (this.options.onProjectRegistered) {
      try {
        await this.options.onProjectRegistered();
      } catch (error) {
        this.log.warn(
          {
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "onProjectRegistered callback failed",
        );
      }
    }
    return {
      outcome: "success",
      run: { ...run, registeredAt: this.now(), updatedAt: this.now() },
    };
  }

  private createNewRun(
    kind: DesignRunKind,
    slug: string,
    feature: string | null,
    requirement: DesignRequirement,
    repoPath: string,
  ): DesignRunRecord {
    const now = this.now();
    return {
      id: this.newId(),
      slug,
      feature,
      kind,
      state: "validating",
      createdAt: now,
      updatedAt: now,
      requirement,
      repoPath,
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
      failureReason: null,
      queuePosition: null,
      completedAt: null,
    };
  }

  private reconcileRun(
    existing: DesignRunRecord,
    requirement: DesignRequirement,
    repoPath: string,
    redraft: boolean,
  ): DesignRunRecord {
    const base: DesignRunRecord = {
      ...existing,
      requirement,
      repoPath: existing.repoPath ?? repoPath,
      updatedAt: this.now(),
      failureReason: null,
    };
    if (redraft) {
      return {
        ...base,
        designDocPath: null,
        designDocSha: null,
        reviewOutcome: null,
        reviewFindings: null,
        revisionApplied: false,
      };
    }
    return base;
  }

  private transition(
    run: DesignRunRecord,
    patch: { state: DesignRunState; failureReason?: DesignFailureReason | null },
  ): DesignRunRecord {
    const prevState = run.state;
    const next: DesignRunRecord = {
      ...run,
      state: patch.state,
      failureReason: patch.failureReason ?? null,
      updatedAt: this.now(),
    };
    if (prevState !== patch.state) {
      const logData = {
        runId: run.id,
        slug: run.slug,
        feature: run.feature,
        from: prevState,
        to: patch.state,
      };
      if (patch.state === "failed" || patch.state === "blocked") {
        this.log.warn(
          { ...logData, failureReason: patch.failureReason ?? null },
          `design run ${patch.state}`,
        );
      } else {
        this.log.info(logData, `design run ${prevState} → ${patch.state}`);
      }
    }
    return next;
  }

  private persist(run: DesignRunRecord): void {
    this.options.store.upsert(run);
  }

  private requireDesignConfig(): DesignConfig {
    if (!this.options.designConfig) {
      throw new Error(
        "Design flow requires a 'design:' section in ~/.loomforge/config.yaml (repoRoot, defaultBranch, linearTeamKey)",
      );
    }
    return this.options.designConfig;
  }
}

export function buildHandoff(run: DesignRunRecord, notes: string[]): DesignHandoff {
  let registration: DesignHandoff["registration"] = "skipped";
  if (run.kind === "new") {
    if (run.registeredAt) {
      registration = "registered";
    } else if (run.remoteUrl) {
      registration = "needs_registration";
    } else {
      registration = "needs_remote";
    }
  }

  return {
    version: 1,
    designRunId: run.id,
    kind: run.kind,
    slug: run.slug,
    feature: run.feature,
    state: run.state,
    localDocPath: run.designDocPath,
    linearProjectUrl: run.linearProjectUrl,
    linearDocumentUrl: run.linearDocumentUrl,
    registration,
    notes,
    failureReason: run.failureReason,
  };
}

export function designDocRelativePath(run: { slug: string; feature: string | null }): string {
  if (run.feature) {
    return join("docs", "design", `${run.slug}-${run.feature}-design.md`);
  }
  return join("docs", "design", `${run.slug}-design.md`);
}

export function documentTitle(run: { slug: string; feature: string | null }): string {
  return run.feature ? `${run.slug}-${run.feature}` : run.slug;
}

export function resumeStateFor(run: DesignRunRecord): DesignRunState {
  if (!run.repoPath) return run.kind === "new" ? "validating" : "drafting";
  if (!run.designDocSha) return run.kind === "new" ? "scaffolding" : "drafting";
  if (!run.reviewOutcome) return "reviewing";
  if (run.reviewOutcome === "revise" && !run.revisionApplied) return "revising";
  if (!run.linearProjectId || !run.linearDocumentId) return "publishing";
  if (run.kind === "new") return "registering";
  return "complete";
}

function buildRequirement(
  requirementPath: string | undefined,
  requirementText: string | undefined,
): DesignRequirement {
  if (requirementPath && requirementPath.trim().length > 0) {
    return { source: "path", ref: resolve(requirementPath) };
  }
  if (requirementText && requirementText.trim().length > 0) {
    return { source: "text", ref: requirementText };
  }
  throw new Error("Requirement not provided");
}

async function readRemoteUrlSafe(repoPath: string): Promise<string | null> {
  const { readRemoteUrl } = await import("../scaffolding/gh-remote.js");
  return readRemoteUrl(repoPath);
}
