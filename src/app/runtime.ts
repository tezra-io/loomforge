import { join } from "node:path";

import pino, { type Logger } from "pino";

import type { ProjectConfigRegistry } from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { WorkflowEngine } from "../workflow/index.js";
import { createDrainScheduler, type DrainScheduler } from "./drain-scheduler.js";
import { createStubWorkflowDependencies } from "./stub-dependencies.js";

export interface LoomRuntime {
  engine: WorkflowEngine;
  scheduler: DrainScheduler;
  store: SqliteRunStore;
  logger: Logger;
  close(): void;
}

export interface CreateLoomRuntimeOptions {
  registry: ProjectConfigRegistry;
  dbPath?: string;
  logger?: Logger;
}

export function createLoomRuntime(options: CreateLoomRuntimeOptions): LoomRuntime {
  const logger = options.logger ?? pino();
  const dbPath = options.dbPath ?? join(options.registry.runtime.dataRoot, "loom.db");
  const store = SqliteRunStore.open(dbPath);
  const dependencies = createStubWorkflowDependencies();
  const engine = new WorkflowEngine({
    registry: options.registry,
    store,
    linear: dependencies.linear,
    worktrees: dependencies.worktrees,
    builder: dependencies.builder,
    verifier: dependencies.verifier,
    reviewer: dependencies.reviewer,
  });
  const scheduler = createDrainScheduler(engine, logger);

  return {
    engine,
    scheduler,
    store,
    logger,
    close: () => {
      store.close();
    },
  };
}
