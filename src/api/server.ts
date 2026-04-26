import Fastify from "fastify";
import type { Logger } from "pino";
import { z } from "zod";

import type { ArtifactStore } from "../artifacts/index.js";
import type { DrainScheduler } from "../app/drain-scheduler.js";
import type { SqliteRunStore } from "../db/index.js";
import type { DesignEngine } from "../design/index.js";
import { buildHandoff } from "../design/index.js";
import type { LinearAdhocClient } from "../linear/index.js";
import { submitAdhocRun } from "../workflow/index.js";
import type { WorkflowEngine } from "../workflow/index.js";

const submitRunSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
    issueId: z.string().trim().min(1),
    executionMode: z.enum(["run_now_if_idle", "enqueue"]).default("enqueue"),
  })
  .strict();

const submitProjectSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
  })
  .strict();

const submitAdhocSchema = z
  .object({
    project: z.string().trim().min(1),
    prompt: z.string().min(1).max(8000),
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
  adhocLinear?: LinearAdhocClient;
  store?: SqliteRunStore;
  artifactStore?: ArtifactStore;
  designEngine?: DesignEngine;
  designScheduler?: DrainScheduler;
  reloadConfig?: () => Promise<{ projects: number; slugs: string[] }>;
  logger: Logger;
}

const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const slugSchema = z.string().regex(slugPattern);

const designNewSchema = z
  .object({
    slug: slugSchema,
    requirementPath: z.string().trim().min(1).optional(),
    requirementText: z.string().trim().min(1).optional(),
    repoRoot: z.string().trim().min(1).optional(),
    redraft: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.requirementPath) !== Boolean(v.requirementText),
    "Exactly one of requirementPath or requirementText must be provided",
  );

const designExtendSchema = z
  .object({
    slug: slugSchema,
    feature: slugSchema,
    requirementPath: z.string().trim().min(1).optional(),
    requirementText: z.string().trim().min(1).optional(),
    redraft: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.requirementPath) !== Boolean(v.requirementText),
    "Exactly one of requirementPath or requirementText must be provided",
  );

const designIdParamSchema = z.object({ id: z.string().trim().min(1) }).strict();
const designSlugParamSchema = z.object({ slug: slugSchema }).strict();

export function createApiServer(options: CreateApiServerOptions) {
  const server = Fastify({ loggerInstance: options.logger });

  server.get("/health", async () => ({
    status: "ok",
    queueDepth: options.engine.getQueue().length,
  }));

  server.get("/queue", async () => ({
    data: options.engine.getQueue(),
  }));

  server.post("/config/reload", async (_request, reply) => {
    if (!options.reloadConfig) {
      return reply.code(503).send({ error: "config_reload_unavailable" });
    }
    try {
      const result = await options.reloadConfig();
      return reply.code(200).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: "config_reload_failed", details: message });
    }
  });

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

  server.post("/runs/adhoc", async (request, reply) => {
    if (!options.adhocLinear) {
      return reply.code(501).send({ error: "adhoc_unavailable" });
    }

    const parsed = submitAdhocSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_failed", details: parsed.error.flatten() });
    }

    const result = await submitAdhocRun(
      {
        registry: options.engine.getRegistry(),
        linear: options.adhocLinear,
        engine: options.engine,
        scheduler: options.scheduler,
        now: () => new Date(),
      },
      parsed.data,
    );

    if (result.ok) {
      return reply.code(200).send({
        runId: result.runId,
        issueId: result.issueId,
        linearUrl: result.linearUrl,
        queuePosition: result.queuePosition,
      });
    }

    switch (result.error) {
      case "validation_failed":
        return reply.code(400).send(result);
      case "project_not_found":
        return reply.code(404).send(result);
      case "linear_not_configured":
        return reply.code(409).send(result);
      case "linear_create_failed":
        return reply.code(502).send(result);
      case "submit_after_create_failed":
        return reply.code(500).send(result);
    }
  });

  server.post("/projects/submit", async (request, reply) => {
    const parsed = submitProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      const result = await options.engine.submitProject(parsed.data.projectSlug);
      options.scheduler.schedule();
      return reply.code(202).send(result);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  server.get("/projects/:slug/status", async (request, reply) => {
    const parsed = z.object({ slug: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      return options.engine.getProjectStatus(parsed.data.slug);
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

  server.post("/runs/:id/retry", async (request, reply) => {
    const parsed = runIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      const run = options.engine.retryRun(parsed.data.id);
      options.scheduler.schedule();
      return { run };
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("Unknown run")) {
        return reply.code(404).send({ error: "run_not_found" });
      }
      return reply.code(409).send({ error: message });
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

  if (options.designEngine) {
    const designEngine = options.designEngine;
    const designScheduler = options.designScheduler;

    server.post("/design/new", async (request, reply) => {
      const parsed = designNewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }

      try {
        const run = await designEngine.startNew(parsed.data);
        const handoff = buildHandoff(run, []);
        designScheduler?.schedule();
        return reply.code(202).send({ run: cloneJson(run), handoff });
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    });

    server.post("/design/extend", async (request, reply) => {
      const parsed = designExtendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }

      try {
        const run = await designEngine.startExtend(parsed.data);
        const handoff = buildHandoff(run, []);
        designScheduler?.schedule();
        return reply.code(202).send({ run: cloneJson(run), handoff });
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    });

    server.get("/design/:id", async (request, reply) => {
      const parsed = designIdParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }
      const run = designEngine.get(parsed.data.id);
      if (!run) {
        return reply.code(404).send({ error: "design_run_not_found" });
      }
      return { run: cloneJson(run), handoff: buildHandoff(run, []) };
    });

    server.post("/design/:id/cancel", async (request, reply) => {
      const parsed = designIdParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }
      try {
        const run = designEngine.cancel(parsed.data.id);
        return { run: cloneJson(run) };
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes("Unknown design run")) {
          return reply.code(404).send({ error: "design_run_not_found" });
        }
        return reply.code(400).send({ error: message });
      }
    });

    server.post("/design/:id/retry", async (request, reply) => {
      const parsed = designIdParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }
      try {
        const run = await designEngine.retry(parsed.data.id);
        designScheduler?.schedule();
        return { run: cloneJson(run) };
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes("Unknown design run")) {
          return reply.code(404).send({ error: "design_run_not_found" });
        }
        return reply.code(400).send({ error: message });
      }
    });

    server.get("/design/projects/:slug/status", async (request, reply) => {
      const parsed = designSlugParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      }
      const status = designEngine.getStatusForProject(parsed.data.slug);
      return cloneJson(status);
    });
  }

  return server;
}

export type LoomApiServer = ReturnType<typeof createApiServer>;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
