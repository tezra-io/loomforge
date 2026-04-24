import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";

import type { DesignRequirement } from "./types.js";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);
const MAX_REQUIREMENT_BYTES = 256 * 1024;

export async function loadRequirementMarkdown(requirement: DesignRequirement): Promise<string> {
  if (requirement.source === "text") {
    return requirement.ref;
  }
  if (!isAbsolute(requirement.ref)) {
    throw new Error(`Requirement path must be absolute: ${requirement.ref}`);
  }

  assertAllowedRequirementPath(requirement.ref);

  let size: number;
  try {
    const stats = await stat(requirement.ref);
    if (!stats.isFile()) {
      throw new Error(`Requirement path is not a regular file: ${requirement.ref}`);
    }
    size = stats.size;
  } catch (error) {
    throw new Error(`Failed to stat requirement file at ${requirement.ref}`, { cause: error });
  }

  if (size > MAX_REQUIREMENT_BYTES) {
    throw new Error(
      `Requirement file exceeds ${MAX_REQUIREMENT_BYTES} bytes (${size}): ${requirement.ref}`,
    );
  }

  try {
    return await readFile(requirement.ref, "utf8");
  } catch (error) {
    throw new Error(`Failed to read requirement file at ${requirement.ref}`, { cause: error });
  }
}

export function assertAllowedRequirementPath(path: string): void {
  const ext = extname(path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Requirement path must end in .md or .txt: ${path}`);
  }
  const resolved = resolve(path);
  const segments = resolved.split(sep).filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment.startsWith(".") && segment !== "." && segment !== "..") {
      throw new Error(`Requirement path must not contain hidden segments: ${path}`);
    }
  }
  const name = basename(resolved);
  if (name.startsWith(".")) {
    throw new Error(`Requirement filename must not be hidden: ${path}`);
  }
}
