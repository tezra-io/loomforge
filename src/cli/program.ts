import { resolve } from "node:path";

import { Command } from "commander";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "../index.js";
import { startLoomServer } from "../app/server.js";
import { createHttpAdapter } from "../mcp/http-adapter.js";
import { createMcpServer } from "../mcp/server.js";
import { requestJson } from "./http-client.js";

export interface CreateCliProgramOptions {
  write?: (text: string) => void;
}

export function createCliProgram(options: CreateCliProgramOptions = {}): Command {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const program = new Command();

  program.name("loom").description("Local workflow engine for agentic delivery").version(VERSION);

  program
    .command("start")
    .description("Start the local loomd HTTP daemon")
    .requiredOption("-c, --config <path>", "project registry YAML file")
    .option("--db <path>", "SQLite database path")
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("-p, --port <port>", "port to bind", parsePort, 3777)
    .option("--log-level <level>", "pino log level", "info")
    .action(async (commandOptions: StartCommandOptions) => {
      const running = await startLoomServer({
        configPath: resolve(commandOptions.config),
        dbPath: commandOptions.db ? resolve(commandOptions.db) : undefined,
        host: commandOptions.host,
        port: commandOptions.port,
        logLevel: commandOptions.logLevel,
      });
      writeJson(write, { status: "started", url: running.url });

      const close = async () => {
        await running.close();
        process.exit(0);
      };
      process.once("SIGINT", () => {
        void close();
      });
      process.once("SIGTERM", () => {
        void close();
      });
    });

  program
    .command("status")
    .description("Check daemon health")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (commandOptions: UrlCommandOptions) => {
      writeJson(write, await requestJson({ baseUrl: commandOptions.url }, "GET", "/health"));
    });

  program
    .command("submit")
    .description("Submit a Linear issue run")
    .argument("<projectSlug>")
    .argument("<issueId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .option("--mode <mode>", "run_now_if_idle or enqueue", "enqueue")
    .action(async (projectSlug: string, issueId: string, commandOptions: SubmitCommandOptions) => {
      writeJson(
        write,
        await requestJson({ baseUrl: commandOptions.url }, "POST", "/runs", {
          projectSlug,
          issueId,
          executionMode: commandOptions.mode,
        }),
      );
    });

  program
    .command("queue")
    .description("List queued runs")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (commandOptions: UrlCommandOptions) => {
      writeJson(write, await requestJson({ baseUrl: commandOptions.url }, "GET", "/queue"));
    });

  program
    .command("get")
    .description("Get a run by ID")
    .argument("<runId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (runId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "GET",
          `/runs/${encodeURIComponent(runId)}`,
        ),
      );
    });

  program
    .command("cancel")
    .description("Cancel a run")
    .argument("<runId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (runId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "POST",
          `/runs/${encodeURIComponent(runId)}/cancel`,
        ),
      );
    });

  program
    .command("mcp-serve")
    .description("Start a stdio MCP server that proxies to the running daemon")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (commandOptions: UrlCommandOptions) => {
      const adapter = createHttpAdapter({ baseUrl: commandOptions.url });
      const mcp = createMcpServer(adapter);
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
    });

  return program;
}

interface StartCommandOptions {
  config: string;
  db?: string;
  host: string;
  port: number;
  logLevel: string;
}

interface UrlCommandOptions {
  url: string;
}

interface SubmitCommandOptions extends UrlCommandOptions {
  mode: string;
}

function defaultDaemonUrl(): string {
  return process.env.LOOM_URL ?? "http://127.0.0.1:3777";
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}
