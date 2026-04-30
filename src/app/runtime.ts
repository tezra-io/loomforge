import { homedir } from "node:os";
import { join } from "node:path";

import pino, { type Logger } from "pino";

import { ArtifactStore } from "../artifacts/index.js";
import {
  loadProjectConfigRegistry,
  type GlobalConfig,
  type ProjectConfigRegistry,
} from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { DesignEngine, SqliteDesignRunStore, type DesignEngineOptions } from "../design/index.js";
import {
  LinearWorkflowClientImpl,
  createMissingKeyClient,
  type LinearAdhocClient,
} from "../linear/index.js";
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

export interface ReloadConfigResult {
  projects: number;
  slugs: string[];
}

export interface LoomRuntime {
  engine: WorkflowEngine;
  designEngine: DesignEngine;
  scheduler: DrainScheduler;
  designScheduler: DrainScheduler;
  store: SqliteRunStore;
  artifactStore: ArtifactStore;
  adhocLinear: LinearAdhocClient;
  logger: Logger;
  reloadConfig(): Promise<ReloadConfigResult>;
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
  const builder = new BuilderRunnerImpl({
    artifactDir,
    tool: "claude",
    logger: logger.child({ component: "builder" }),
  });
  const reviewer = new ReviewerRunnerImpl({
    artifactDir,
    tool: "claude",
    logger: logger.child({ component: "reviewer" }),
  });
  const worktrees = new GitWorkspaceManager();
  const linearApiKey = resolveLinearApiKey(options.globalConfig?.linear?.apiKey, process.env);
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
  const loomConfigPath = options.loomConfigPath ?? join(homedir(), ".loomforge", "loom.yaml");
  const reloadConfig = async (): Promise<ReloadConfigResult> => {
    const next = await loadProjectConfigRegistry(loomConfigPath, { homeDir: homedir() });
    engine.setRegistry(next);
    designEngine.setRegistry(next);
    logger.info({ projects: next.projects.length, path: loomConfigPath }, "registry reloaded");
    return {
      projects: next.projects.length,
      slugs: next.projects.map((p) => p.slug),
    };
  };
  const designEngineOptions: DesignEngineOptions = {
    store: designStore,
    linear,
    builder: new DesignBuilderRunner(),
    reviewer: new DesignReviewerRunner(),
    registry: options.registry,
    designConfig: options.globalConfig?.design ?? null,
    loomConfigPath,
    artifactDir: designArtifactDir,
    builderTool: "codex",
    reviewerTool: "claude",
    logger: logger.child({ component: "design-engine" }),
    onProjectRegistered: async () => {
      await reloadConfig();
    },
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
    adhocLinear: linear,
    logger,
    reloadConfig,
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
