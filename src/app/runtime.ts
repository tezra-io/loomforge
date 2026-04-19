import { join } from "node:path";

import pino, { type Logger } from "pino";

import { ArtifactStore } from "../artifacts/index.js";
import type { GlobalConfig, ProjectConfigRegistry } from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { LinearWorkflowClientImpl, createMissingKeyClient } from "../linear/index.js";
import { BuilderRunnerImpl, ReviewerRunnerImpl } from "../runners/index.js";
import { WorkflowEngine } from "../workflow/index.js";
import { GitWorkspaceManager } from "../worktrees/index.js";
import { GhPullRequestCreator } from "../worktrees/pull-request-creator.js";
import { createDrainScheduler, type DrainScheduler } from "./drain-scheduler.js";

export interface LoomRuntime {
  engine: WorkflowEngine;
  scheduler: DrainScheduler;
  store: SqliteRunStore;
  artifactStore: ArtifactStore;
  logger: Logger;
  close(): void;
}

export interface CreateLoomRuntimeOptions {
  registry: ProjectConfigRegistry;
  globalConfig?: GlobalConfig;
  dbPath?: string;
  logger?: Logger;
}

export function createLoomRuntime(options: CreateLoomRuntimeOptions): LoomRuntime {
  const logger = options.logger ?? pino();
  const dbPath = options.dbPath ?? join(options.registry.runtime.dataRoot, "loom.db");
  const store = SqliteRunStore.open(dbPath);
  const artifactDir = join(options.registry.runtime.dataRoot, "artifacts");
  const builder = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
  const reviewer = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
  const worktrees = new GitWorkspaceManager();
  const linearApiKey = options.globalConfig?.linear.apiKey ?? process.env.LINEAR_API_KEY;
  const linear = linearApiKey
    ? new LinearWorkflowClientImpl(linearApiKey)
    : createMissingKeyClient();
  const artifacts = new ArtifactStore(options.registry.runtime.dataRoot);
  const pullRequests = new GhPullRequestCreator();
  const engine = new WorkflowEngine({
    registry: options.registry,
    store,
    artifacts,
    linear,
    worktrees,
    builder,
    reviewer,
    pullRequests,
    logger: logger.child({ component: "engine" }),
    onProjectComplete: (result) => {
      logger.info(
        {
          projectSlug: result.projectSlug,
          shipped: result.shipped,
          failed: result.failed,
          blocked: result.blocked,
          pullRequestUrl: result.pullRequestUrl,
        },
        "project completion",
      );
    },
  });
  const scheduler = createDrainScheduler(engine, logger);

  return {
    engine,
    scheduler,
    store,
    artifactStore: artifacts,
    logger,
    close: () => {
      store.close();
    },
  };
}
