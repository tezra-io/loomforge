import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface LoomYamlProjectEntry {
  slug: string;
  repoRoot: string;
  defaultBranch: string;
  devBranch: string;
  linearTeamKey: string;
  linearProjectName: string;
  builder: "codex" | "claude";
  reviewer: "codex" | "claude";
  verification: {
    commands: Array<{ name: string; command: string }>;
  };
}

export type AppendLoomYamlResult =
  | { outcome: "appended"; path: string }
  | { outcome: "already_present"; path: string }
  | { outcome: "failed"; summary: string };

export async function appendLoomYamlProject(
  configPath: string,
  entry: LoomYamlProjectEntry,
): Promise<AppendLoomYamlResult> {
  try {
    const existing = await safeReadFile(configPath);
    const doc = parseExistingDoc(existing);
    if (projectSlugExists(doc, entry.slug)) {
      return { outcome: "already_present", path: configPath };
    }

    const projects = doc["projects"];
    const projectsList = Array.isArray(projects) ? [...projects] : [];
    projectsList.push(entry);
    doc["projects"] = projectsList;

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, stringifyYaml(doc), "utf8");
    return { outcome: "appended", path: configPath };
  } catch (error) {
    return {
      outcome: "failed",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export function defaultVerificationPlaceholder(): LoomYamlProjectEntry["verification"] {
  return {
    commands: [
      {
        name: "placeholder",
        command: "echo 'TODO: replace with real verification command in ~/.loomforge/loom.yaml'",
      },
    ],
  };
}

function parseExistingDoc(text: string | null): Record<string, unknown> {
  if (!text || text.trim().length === 0) {
    return { projects: [] };
  }
  const parsed = parseYaml(text) as unknown;
  if (parsed === null || parsed === undefined) {
    return { projects: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("loom.yaml root must be a mapping");
  }
  return parsed as Record<string, unknown>;
}

function projectSlugExists(doc: Record<string, unknown>, slug: string): boolean {
  const projects = doc["projects"];
  if (!Array.isArray(projects)) return false;
  return projects.some((p) => {
    if (typeof p !== "object" || p === null) return false;
    return (p as Record<string, unknown>)["slug"] === slug;
  });
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
