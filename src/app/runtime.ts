import { join } from "node:path";

import pino, { type Logger } from "pino";

import type { ProjectConfigRegistry } from "../config/index.js";
import { SqliteRunStore } from "../db/index.js";
import { VerificationRunner } from "../runners/index.js";
import { WorkflowEngine } from "../workflow/index.js";
import { GitWorkspaceManager } from "../worktrees/index.js";
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
  const stubs = createStubWorkflowDependencies();
  const artifactDir = join(options.registry.runtime.dataRoot, "artifacts");
  const verifier = new VerificationRunner({ artifactDir });
  const worktrees = new GitWorkspaceManager();
  const engine = new WorkflowEngine({
    registry: options.registry,
    store,
    linear: stubs.linear,
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
    logger,
    close: () => {
      store.close();
    },
  };
}
