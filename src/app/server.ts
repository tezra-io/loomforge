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
  const logger = pino({ level: options.logLevel ?? "info" });
  const home = homedir();
  const registry = await loadProjectConfigRegistry(options.configPath, { homeDir: home });

  const globalConfigPath = join(home, ".loom", "config.yaml");
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
  });
  const server = createApiServer({
    engine: runtime.engine,
    scheduler: runtime.scheduler,
    store: runtime.store,
    artifactStore: runtime.artifactStore,
    logger,
  });
  const url = await server.listen({ host: options.host, port: options.port });

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
