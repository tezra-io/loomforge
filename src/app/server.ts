import { homedir } from "node:os";

import pino from "pino";

import { createApiServer, type LoomApiServer } from "../api/server.js";
import { loadProjectConfigRegistry } from "../config/index.js";
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
  const registry = await loadProjectConfigRegistry(options.configPath, { homeDir: homedir() });
  const runtime = createLoomRuntime({
    registry,
    dbPath: options.dbPath,
    logger,
  });
  const server = createApiServer({
    engine: runtime.engine,
    scheduler: runtime.scheduler,
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
