import { homedir } from "node:os";
import { join } from "node:path";

import pino, { type Logger } from "pino";

import { ArtifactStore } from "../artifacts/index.js";
import type { GlobalConfig, ProjectConfigRegistry } from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { DesignEngine, SqliteDesignRunStore, type DesignEngineOptions } from "../design/index.js";
import { LinearWorkflowClientImpl, createMissingKeyClient } from "../linear/index.js";
import {
  BuilderRunnerImpl,
  DesignBuilderRunner,
  DesignReviewerRunner,
  ReviewerRunnerImpl,
} from "../runners/index.js";
import { WorkflowEngine } from "../workflow/index.js";
import { GitWorkspaceManager } from "../worktrees/index.js";
import { GhPullRequestCreator } from "../worktrees/pull-request-creator.js";
import {
  createDrainScheduler,
  createGenericDrainScheduler,
  type DrainScheduler,
} from "./drain-scheduler.js";

const linearApiKeyPlaceholder = "lin_api_YOUR_KEY_HERE";

export interface LoomRuntime {
  engine: WorkflowEngine;
  designEngine: DesignEngine;
  scheduler: DrainScheduler;
  designScheduler: DrainScheduler;
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
  loomConfigPath?: string;
}

export function createLoomRuntime(options: CreateLoomRuntimeOptions): LoomRuntime {
  const logger = options.logger ?? pino();
  const dbPath = options.dbPath ?? join(options.registry.runtime.dataRoot, "loom.db");
  const store = SqliteRunStore.open(dbPath);
  const artifactDir = join(options.registry.runtime.dataRoot, "artifacts");
  const builder = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
  const reviewer = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
  const worktrees = new GitWorkspaceManager();
  const linearApiKey = resolveLinearApiKey(options.globalConfig?.linear.apiKey, process.env);
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

  const designStore = new SqliteDesignRunStore(store.rawDb());
  const designArtifactDir = join(options.registry.runtime.dataRoot, "design-artifacts");
  const designEngineOptions: DesignEngineOptions = {
    store: designStore,
    linear,
    builder: new DesignBuilderRunner(),
    reviewer: new DesignReviewerRunner(),
    registry: options.registry,
    designConfig: options.globalConfig?.design ?? null,
    loomConfigPath: options.loomConfigPath ?? join(homedir(), ".loomforge", "loom.yaml"),
    artifactDir: designArtifactDir,
    builderTool: "codex",
    reviewerTool: "claude",
    logger: logger.child({ component: "design-engine" }),
  };
  const designEngine = new DesignEngine(designEngineOptions);
  const designScheduler = createGenericDrainScheduler(
    designEngine,
    logger.child({ component: "design-scheduler" }),
    "design",
  );

  return {
    engine,
    designEngine,
    scheduler,
    designScheduler,
    store,
    artifactStore: artifacts,
    logger,
    close: () => {
      store.close();
    },
  };
}

export function resolveLinearApiKey(
  configuredKey: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const trimmedConfiguredKey = configuredKey?.trim();
  if (trimmedConfiguredKey && trimmedConfiguredKey !== linearApiKeyPlaceholder) {
    return trimmedConfiguredKey;
  }

  const envKey = env.LINEAR_API_KEY?.trim();
  return envKey || undefined;
}
