import { join } from "node:path";

import pino, { type Logger } from "pino";

import { ArtifactStore } from "../artifacts/index.js";
import type { GlobalConfig, ProjectConfigRegistry } from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { LinearWorkflowClientImpl, createMissingKeyClient } from "../linear/index.js";
import { VerificationRunner } from "../runners/index.js";
import { WorkflowEngine } from "../workflow/index.js";
import { GitWorkspaceManager } from "../worktrees/index.js";
import { createDrainScheduler, type DrainScheduler } from "./drain-scheduler.js";
import { createStubWorkflowDependencies } from "./stub-dependencies.js";

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
  const stubs = createStubWorkflowDependencies();
  const artifactDir = join(options.registry.runtime.dataRoot, "artifacts");
  const verifier = new VerificationRunner({ artifactDir });
  const worktrees = new GitWorkspaceManager();
  const linear = options.globalConfig
    ? new LinearWorkflowClientImpl(options.globalConfig.linear.apiKey)
    : createMissingKeyClient();
  const artifacts = new ArtifactStore(options.registry.runtime.dataRoot);
  const engine = new WorkflowEngine({
    registry: options.registry,
    store,
    artifacts,
    linear,
    worktrees,
    builder: stubs.builder,
    verifier,
    reviewer: stubs.reviewer,
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
