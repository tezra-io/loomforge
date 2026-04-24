import { readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import pino from "pino";

import { createApiServer, type LoomApiServer } from "../api/server.js";
import { loadProjectConfigRegistry, loadGlobalConfig } from "../config/index.js";
import { createLoomRuntime, type LoomRuntime } from "./runtime.js";

export interface StartServerOptions {
  configPath: string;
  dbPath?: string;
  host: string;
  port: number;
  logLevel?: string;
}

export interface RunningLoomServer {
  server: LoomApiServer;
  runtime: LoomRuntime;
  url: string;
  close(): Promise<void>;
}

export async function startLoomServer(options: StartServerOptions): Promise<RunningLoomServer> {
  const logDir = join(homedir(), ".loomforge", "logs");
  mkdirSync(logDir, { recursive: true });

  const logFile = join(logDir, `loomforge-${todayStamp()}.log`);
  pruneOldLogs(logDir, 7);

  const logger = pino(
    { level: options.logLevel ?? "info" },
    pino.multistream([{ stream: pino.destination(1) }, { stream: pino.destination(logFile) }]),
  );
  const home = homedir();
  const registry = await loadProjectConfigRegistry(options.configPath, { homeDir: home });

  const globalConfigPath = join(home, ".loomforge", "config.yaml");
  let globalConfig;
  try {
    globalConfig = await loadGlobalConfig(globalConfigPath);
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      logger.warn("Global config not found at %s — Linear integration disabled", globalConfigPath);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(
        "Invalid global config at %s: %s — Linear integration disabled",
        globalConfigPath,
        detail,
      );
    }
  }

  const runtime = createLoomRuntime({
    registry,
    globalConfig,
    dbPath: options.dbPath,
    logger,
    loomConfigPath: options.configPath,
  });
  const server = createApiServer({
    engine: runtime.engine,
    scheduler: runtime.scheduler,
    store: runtime.store,
    artifactStore: runtime.artifactStore,
    designEngine: runtime.designEngine,
    designScheduler: runtime.designScheduler,
    logger,
  });
  const url = await server.listen({ host: options.host, port: options.port });

  runtime.scheduler.schedule();
  runtime.designScheduler.schedule();

  return {
    server,
    runtime,
    url,
    close: async () => {
      await server.close();
      runtime.close();
    },
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pruneOldLogs(logDir: string, retainDays: number): void {
  const cutoff = Date.now() - retainDays * 86_400_000;
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^loomforge-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!match?.[1]) continue;
    if (new Date(match[1]).getTime() < cutoff) {
      try {
        unlinkSync(join(logDir, name));
      } catch {
        // best-effort cleanup
      }
    }
  }
}
