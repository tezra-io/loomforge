import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { Command } from "commander";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "../index.js";
import { startLoomServer } from "../app/server.js";
import { createHttpAdapter } from "../mcp/http-adapter.js";
import { createMcpServer } from "../mcp/server.js";
import { requestJson } from "./http-client.js";
import { runSetup, type RunSetupOptions } from "./setup.js";

export interface CreateCliProgramOptions {
  write?: (text: string) => void;
  runSetup?: (options?: RunSetupOptions) => Promise<void> | void;
  fetch?: typeof fetch;
}

export function createCliProgram(options: CreateCliProgramOptions = {}): Command {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const runSetupCommand = options.runSetup ?? runSetup;
  const fetchImpl = options.fetch;
  const program = new Command();

  program
    .name("loomforge")
    .description("Local workflow engine for agentic delivery")
    .version(VERSION);

  program
    .command("start")
    .description("Start the local loomforged HTTP daemon")
    .option("-c, --config <path>", "project registry YAML file", defaultConfigPath())
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
    .description("Submit issue(s) for a project. Omit issueId to enqueue all actionable issues.")
    .argument("<projectSlug>")
    .argument("[issueId]")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .option("--mode <mode>", "run_now_if_idle or enqueue", "enqueue")
    .action(
      async (
        projectSlug: string,
        issueId: string | undefined,
        commandOptions: SubmitCommandOptions,
      ) => {
        if (issueId) {
          writeJson(
            write,
            await requestJson({ baseUrl: commandOptions.url }, "POST", "/runs", {
              projectSlug,
              issueId,
              executionMode: commandOptions.mode,
            }),
          );
        } else {
          writeJson(
            write,
            await requestJson({ baseUrl: commandOptions.url }, "POST", "/projects/submit", {
              projectSlug,
            }),
          );
        }
      },
    );

  program
    .command("run")
    .description("Submit an ad-hoc prompt-driven run for a project")
    .argument("<prompt>")
    .requiredOption(
      "-p, --project <slug-or-path>",
      "registered project slug or absolute path to its repoRoot",
    )
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (prompt: string, commandOptions: RunCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
          "POST",
          "/runs/adhoc",
          { project: commandOptions.project, prompt },
        ),
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
    .command("retry")
    .description("Retry a failed or blocked run")
    .argument("<runId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (runId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "POST",
          `/runs/${encodeURIComponent(runId)}/retry`,
        ),
      );
    });

  const configCommand = program
    .command("config")
    .description("Inspect and reload Loomforge configuration");

  configCommand
    .command("reload")
    .description("Re-read ~/.loomforge/loom.yaml on the running daemon")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson({ baseUrl: commandOptions.url }, "POST", "/config/reload"),
      );
    });

  const designCommand = program
    .command("design")
    .description("Design-flow commands (scaffold → draft → review → publish)");

  designCommand
    .command("new")
    .description("Scaffold a new project, draft & review a design doc, publish to Linear")
    .argument("<slug>")
    .option("--requirement-path <path>", "absolute path to a requirement markdown file")
    .option("--requirement-text <text>", "requirement content as a string")
    .option("--repo-root <path>", "override the default design.repoRoot from config")
    .option("--redraft", "force a fresh draft even if a prior draft exists", false)
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (slug: string, commandOptions: DesignNewCommandOptions) => {
      writeJson(
        write,
        await requestJson({ baseUrl: commandOptions.url }, "POST", "/design/new", {
          slug,
          requirementPath: commandOptions.requirementPath,
          requirementText: commandOptions.requirementText,
          repoRoot: commandOptions.repoRoot,
          redraft: Boolean(commandOptions.redraft),
        }),
      );
    });

  designCommand
    .command("extend")
    .description("Draft a feature-extension design doc for an existing project")
    .argument("<slug>")
    .requiredOption("--feature <slug>", "feature slug (lowercase, hyphen-separated)")
    .option("--requirement-path <path>", "absolute path to a requirement markdown file")
    .option("--requirement-text <text>", "requirement content as a string")
    .option("--redraft", "force a fresh draft even if a prior draft exists", false)
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (slug: string, commandOptions: DesignExtendCommandOptions) => {
      writeJson(
        write,
        await requestJson({ baseUrl: commandOptions.url }, "POST", "/design/extend", {
          slug,
          feature: commandOptions.feature,
          requirementPath: commandOptions.requirementPath,
          requirementText: commandOptions.requirementText,
          redraft: Boolean(commandOptions.redraft),
        }),
      );
    });

  designCommand
    .command("get")
    .description("Fetch a design run by ID")
    .argument("<designRunId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (designRunId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "GET",
          `/design/${encodeURIComponent(designRunId)}`,
        ),
      );
    });

  designCommand
    .command("cancel")
    .description("Cancel a design run")
    .argument("<designRunId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (designRunId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "POST",
          `/design/${encodeURIComponent(designRunId)}/cancel`,
        ),
      );
    });

  designCommand
    .command("retry")
    .description("Retry a failed or stuck design run")
    .argument("<designRunId>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (designRunId: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "POST",
          `/design/${encodeURIComponent(designRunId)}/retry`,
        ),
      );
    });

  designCommand
    .command("status")
    .description("Fetch the latest design-run status for a project slug")
    .argument("<slug>")
    .option("-u, --url <url>", "daemon URL", defaultDaemonUrl())
    .action(async (slug: string, commandOptions: UrlCommandOptions) => {
      writeJson(
        write,
        await requestJson(
          { baseUrl: commandOptions.url },
          "GET",
          `/design/projects/${encodeURIComponent(slug)}/status`,
        ),
      );
    });

  program
    .command("setup")
    .description("Validate config, install agent skill, and show next steps")
    .action(async () => {
      await runSetupCommand({ write });
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

interface RunCommandOptions extends UrlCommandOptions {
  project: string;
}

interface DesignNewCommandOptions extends UrlCommandOptions {
  requirementPath?: string;
  requirementText?: string;
  repoRoot?: string;
  redraft?: boolean;
}

interface DesignExtendCommandOptions extends UrlCommandOptions {
  feature: string;
  requirementPath?: string;
  requirementText?: string;
  redraft?: boolean;
}

function defaultConfigPath(): string {
  return join(homedir(), ".loomforge", "loom.yaml");
}

function defaultDaemonUrl(): string {
  return process.env.LOOMFORGE_URL ?? "http://127.0.0.1:3777";
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
