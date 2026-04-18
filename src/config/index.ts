import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const defaultBuilderTimeoutMs = 1_800_000;
const defaultReviewerTimeoutMs = 600_000;
const defaultVerificationTimeoutMs = 300_000;
const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const nonEmptyStringSchema = z.string().trim().min(1);
const pathSchema = z.string().trim().min(1);
const timeoutSchema = z.number().int().positive();
const slugSchema = z.string().regex(slugPattern);

const verificationCommandSchema = z
  .object({
    name: nonEmptyStringSchema,
    // Config is trusted checked-in input; command execution safety is enforced by the runner layer.
    command: nonEmptyStringSchema,
    timeoutMs: timeoutSchema.optional(),
  })
  .strict();

const timeoutsSchema = z
  .object({
    builderMs: timeoutSchema.optional(),
    reviewerMs: timeoutSchema.optional(),
    verificationMs: timeoutSchema.optional(),
  })
  .strict()
  .optional();

const reviewSchema = z
  .object({
    maxRevisionLoops: z.number().int().nonnegative().optional(),
    blockingSeverities: z.array(nonEmptyStringSchema).optional(),
  })
  .strict()
  .optional();

const linearStatusesSchema = z
  .object({
    inProgress: nonEmptyStringSchema.optional(),
    inReview: nonEmptyStringSchema.optional(),
    done: nonEmptyStringSchema.optional(),
    blocked: nonEmptyStringSchema.optional(),
  })
  .strict()
  .optional();

const projectConfigSchema = z
  .object({
    slug: slugSchema,
    repoRoot: pathSchema,
    defaultBranch: nonEmptyStringSchema,
    devBranch: nonEmptyStringSchema.optional(),
    runtimeDataRoot: pathSchema.optional(),
    verification: z
      .object({
        commands: z.array(verificationCommandSchema).nonempty(),
      })
      .strict(),
    timeouts: timeoutsSchema,
    review: reviewSchema,
    linearStatuses: linearStatusesSchema,
  })
  .strict();

const registrySchema = z
  .object({
    runtime: z
      .object({
        dataRoot: pathSchema.optional(),
      })
      .strict()
      .optional(),
    projects: z.array(projectConfigSchema).nonempty(),
  })
  .strict();

const globalConfigSchema = z
  .object({
    linear: z
      .object({
        apiKey: nonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();

const openClawRunRequestSchema = z
  .object({
    projectSlug: slugSchema,
    issueId: nonEmptyStringSchema,
  })
  .strict();

export interface ProjectConfigRegistryOptions {
  homeDir: string;
  configDir?: string;
}

export interface VerificationCommandConfig {
  name: string;
  command: string;
  timeoutMs: number;
}

export interface ProjectTimeoutConfig {
  builderMs: number;
  reviewerMs: number;
  verificationMs: number;
}

export interface ProjectReviewConfig {
  maxRevisionLoops: number;
  blockingSeverities: string[];
}

export interface LinearStatusConfig {
  inProgress: string;
  inReview: string;
  done: string;
  blocked: string;
}

export interface ProjectConfig {
  slug: string;
  repoRoot: string;
  defaultBranch: string;
  devBranch: string;
  runtimeDataRoot: string;
  verification: {
    commands: VerificationCommandConfig[];
  };
  timeouts: ProjectTimeoutConfig;
  review: ProjectReviewConfig;
  linearStatuses: LinearStatusConfig;
}

export interface ProjectConfigRegistry {
  runtime: {
    dataRoot: string;
  };
  projects: ProjectConfig[];
  bySlug: Map<string, ProjectConfig>;
}

export interface GlobalConfig {
  linear: {
    apiKey: string;
  };
}

export interface OpenClawRunRequest {
  projectSlug: string;
  issueId: string;
}

type RawRegistryConfig = z.infer<typeof registrySchema>;
type RawProjectConfig = RawRegistryConfig["projects"][number];

export async function loadProjectConfigRegistry(
  configPath: string,
  options: Omit<ProjectConfigRegistryOptions, "configDir">,
): Promise<ProjectConfigRegistry> {
  const configText = await readFile(configPath, "utf8");

  return parseProjectConfigRegistry(configText, {
    ...options,
    configDir: dirname(resolve(configPath)),
  });
}

export function parseProjectConfigRegistry(
  configText: string,
  options: ProjectConfigRegistryOptions,
): ProjectConfigRegistry {
  let rawConfig: unknown;

  try {
    rawConfig = parseYaml(configText);
  } catch (error) {
    throw new Error("Invalid project config: YAML could not be parsed", {
      cause: error,
    });
  }

  const parsedConfig = registrySchema.safeParse(rawConfig);

  if (!parsedConfig.success) {
    throw new Error("Invalid project config", {
      cause: parsedConfig.error,
    });
  }

  return buildProjectConfigRegistry(parsedConfig.data, options);
}

export function parseOpenClawRunRequest(value: unknown): OpenClawRunRequest {
  const parsedRequest = openClawRunRequestSchema.safeParse(value);

  if (!parsedRequest.success) {
    throw new Error("OpenClaw run requests may only include projectSlug and issueId", {
      cause: parsedRequest.error,
    });
  }

  return parsedRequest.data;
}

export async function loadGlobalConfig(configPath: string): Promise<GlobalConfig> {
  const configText = await readFile(configPath, "utf8");
  return parseGlobalConfig(configText);
}

export function parseGlobalConfig(configText: string): GlobalConfig {
  let rawConfig: unknown;

  try {
    rawConfig = parseYaml(configText);
  } catch (error) {
    throw new Error("Invalid global config: YAML could not be parsed", {
      cause: error,
    });
  }

  const parsed = globalConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    throw new Error("Invalid global config", { cause: parsed.error });
  }

  return parsed.data;
}

function buildProjectConfigRegistry(
  config: RawRegistryConfig,
  options: ProjectConfigRegistryOptions,
): ProjectConfigRegistry {
  const configDir = options.configDir ?? process.cwd();
  const defaultDataRoot = join(options.homeDir, ".loom", "data");
  const dataRoot = resolveConfigPath(config.runtime?.dataRoot ?? defaultDataRoot, configDir);
  const projects = config.projects.map((project) =>
    buildProjectConfig(project, {
      configDir,
      dataRoot,
      homeDir: options.homeDir,
    }),
  );
  const bySlug = new Map<string, ProjectConfig>();

  for (const project of projects) {
    if (bySlug.has(project.slug)) {
      throw new Error("Invalid project config: duplicate project slug");
    }

    bySlug.set(project.slug, project);
  }

  return {
    runtime: {
      dataRoot,
    },
    projects,
    bySlug,
  };
}

function buildProjectConfig(
  project: RawProjectConfig,
  context: {
    configDir: string;
    dataRoot: string;
    homeDir: string;
  },
): ProjectConfig {
  const timeouts: ProjectTimeoutConfig = {
    builderMs: project.timeouts?.builderMs ?? defaultBuilderTimeoutMs,
    reviewerMs: project.timeouts?.reviewerMs ?? defaultReviewerTimeoutMs,
    verificationMs: project.timeouts?.verificationMs ?? defaultVerificationTimeoutMs,
  };

  return {
    slug: project.slug,
    repoRoot: resolveConfigPath(project.repoRoot, context.configDir),
    defaultBranch: project.defaultBranch,
    devBranch: project.devBranch ?? "dev",
    runtimeDataRoot: resolveConfigPath(
      project.runtimeDataRoot ?? join(context.dataRoot, "projects", project.slug),
      context.configDir,
    ),
    verification: {
      commands: project.verification.commands.map((command) => ({
        name: command.name,
        command: command.command,
        timeoutMs: command.timeoutMs ?? timeouts.verificationMs,
      })),
    },
    timeouts,
    review: {
      maxRevisionLoops: project.review?.maxRevisionLoops ?? 3,
      blockingSeverities: project.review?.blockingSeverities ?? ["P0", "P1"],
    },
    linearStatuses: {
      inProgress: project.linearStatuses?.inProgress ?? "In Progress",
      inReview: project.linearStatuses?.inReview ?? "In Review",
      done: project.linearStatuses?.done ?? "Done",
      blocked: project.linearStatuses?.blocked ?? "Blocked",
    },
  };
}

function resolveConfigPath(path: string, configDir: string): string {
  if (isAbsolute(path)) {
    return resolve(path);
  }

  return resolve(configDir, path);
}
