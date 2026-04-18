import Fastify from "fastify";
import type { Logger } from "pino";
import { z } from "zod";

import type { ArtifactStore } from "../artifacts/index.js";
import type { DrainScheduler } from "../app/drain-scheduler.js";
import type { SqliteRunStore } from "../db/index.js";
import type { WorkflowEngine } from "../workflow/index.js";

const submitRunSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
    issueId: z.string().trim().min(1),
    executionMode: z.enum(["run_now_if_idle", "enqueue"]).default("enqueue"),
  })
  .strict();

const cleanupWorkspaceSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
  })
  .strict();

const runIdParamSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

export interface CreateApiServerOptions {
  engine: WorkflowEngine;
  scheduler: DrainScheduler;
  store?: SqliteRunStore;
  artifactStore?: ArtifactStore;
  logger: Logger;
}

export function createApiServer(options: CreateApiServerOptions) {
  const server = Fastify({ loggerInstance: options.logger });

  server.get("/health", async () => ({
    status: "ok",
    queueDepth: options.engine.getQueue().length,
  }));

  server.get("/queue", async () => ({
    data: options.engine.getQueue(),
  }));

  server.post("/runs", async (request, reply) => {
    const parsed = submitRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      const result = options.engine.submitRun(parsed.data);
      if (!result.accepted) {
        return reply.code(409).send(result);
      }

      const response = cloneJson({
        run: result.run,
        queuePosition: result.queuePosition,
      });
      options.scheduler.schedule();
      return reply.code(202).send(response);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  server.get("/runs/:id", async (request, reply) => {
    const parsed = runIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      return { run: options.engine.getRun(parsed.data.id) };
    } catch {
      return reply.code(404).send({ error: "run_not_found" });
    }
  });

  server.post("/runs/:id/cancel", async (request, reply) => {
    const parsed = runIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      return { run: options.engine.cancelRun(parsed.data.id) };
    } catch {
      return reply.code(404).send({ error: "run_not_found" });
    }
  });

  server.post("/workspace/cleanup", async (request, reply) => {
    const parsed = cleanupWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      const result = await options.engine.cleanupWorkspace(parsed.data.projectSlug);
      if (result.outcome === "failed") {
        return reply.code(422).send(result);
      }
      return result;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  server.get("/runs/:id/artifacts", async (request, reply) => {
    const parsed = runIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    if (!options.store) {
      return reply.code(501).send({ error: "artifact_store_unavailable" });
    }

    try {
      options.engine.getRun(parsed.data.id);
    } catch {
      return reply.code(404).send({ error: "run_not_found" });
    }

    const artifacts = options.store.listArtifacts(parsed.data.id);
    return { artifacts };
  });

  server.get("/runs/:id/logs", async (request, reply) => {
    const parsed = runIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { store: runStore, artifactStore: artStore } = options;
    if (!runStore || !artStore) {
      return reply.code(501).send({ error: "artifact_store_unavailable" });
    }

    try {
      options.engine.getRun(parsed.data.id);
    } catch {
      return reply.code(404).send({ error: "run_not_found" });
    }

    const artifacts = runStore.listArtifacts(parsed.data.id);
    const logArtifacts = artifacts.filter(
      (a) => a.kind === "issue_snapshot" || a.kind === "handoff",
    );
    const logs = await Promise.all(
      logArtifacts.map(async (a) => ({
        id: a.id,
        kind: a.kind,
        content: await artStore.readContent(a.path),
      })),
    );

    return { logs: logs.filter((l) => l.content !== null) };
  });

  return server;
}

export type LoomApiServer = ReturnType<typeof createApiServer>;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
