import Fastify from "fastify";
import type { Logger } from "pino";
import { z } from "zod";

import type { DrainScheduler } from "../app/drain-scheduler.js";
import type { WorkflowEngine } from "../workflow/index.js";

const submitRunSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
    issueId: z.string().trim().min(1),
    executionMode: z.enum(["run_now_if_idle", "enqueue"]).default("enqueue"),
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

  return server;
}

export type LoomApiServer = ReturnType<typeof createApiServer>;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
