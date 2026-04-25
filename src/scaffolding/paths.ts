import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function templatesRoot(): string {
  return resolve(moduleDir, "..", "..", "templates");
}

export function claudeTemplatePath(): string {
  return resolve(templatesRoot(), "CLAUDE_TEMPLATE.md");
}

export function designTemplatePath(): string {
  return resolve(templatesRoot(), "DESIGN_TEMPLATE.md");
}
