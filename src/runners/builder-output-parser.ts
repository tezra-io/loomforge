import { createHash } from "node:crypto";

import { extractJsonCandidates, recoverTruncatedJson } from "./json-output-parser.js";

export type BuilderOutputOutcome = "success" | "failed_no_changes";
export type BuilderVerificationOutcome = "pass" | "fail" | "not_run";

export interface BuilderOutputVerification {
  command: string;
  outcome: BuilderVerificationOutcome;
  summary: string;
}

export interface BuilderOutputPayload {
  outcome: BuilderOutputOutcome;
  changed_files: string[];
  summary: string;
  verification: BuilderOutputVerification[];
  blocker: string;
}

export type BuilderOutputParseReason = "no_json" | "invalid_shape";

export type BuilderOutputParseResult =
  | { ok: true; payload: BuilderOutputPayload }
  | { ok: false; reason: BuilderOutputParseReason };

// Codex schema mode currently requires every declared property in required.
export const BUILDER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["success", "failed_no_changes"],
    },
    changed_files: {
      type: "array",
      items: { type: "string" },
    },
    summary: { type: "string" },
    verification: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: {
            type: "string",
            enum: ["pass", "fail", "not_run"],
          },
          summary: { type: "string" },
        },
        required: ["command", "outcome", "summary"],
        additionalProperties: false,
      },
    },
    blocker: { type: "string" },
  },
  required: ["outcome", "changed_files", "summary", "verification", "blocker"],
  additionalProperties: false,
} as const;

export function builderOutputSchemaText(): string {
  return JSON.stringify(BUILDER_OUTPUT_SCHEMA, null, 2) + "\n";
}

export function builderOutputSchemaHash(): string {
  return createHash("sha256").update(builderOutputSchemaText()).digest("hex");
}

export function parseBuilderOutputText(text: string): BuilderOutputParseResult {
  const candidates = extractJsonCandidates(text);

  for (const candidate of candidates) {
    const parsed = tryParseBuilderOutput(candidate);
    if (parsed) return { ok: true, payload: parsed };
  }

  const recovered = recoverTruncatedJson(text);
  if (recovered) {
    const parsed = tryParseBuilderOutput(recovered);
    if (parsed) return { ok: true, payload: parsed };
  }

  if (candidates.length === 0) return { ok: false, reason: "no_json" };
  return { ok: false, reason: "invalid_shape" };
}

export function extractCodexFinalAssistantText(eventsJsonl: string): string | null {
  let finalText: string | null = null;

  for (const line of eventsJsonl.split(/\r?\n/)) {
    const event = parseObject(line);
    if (!event || event["type"] !== "item.completed") continue;

    const item = event["item"];
    if (!isObject(item) || item["type"] !== "agent_message") continue;
    if (typeof item["text"] === "string") finalText = item["text"];
  }

  return finalText;
}

function tryParseBuilderOutput(text: string): BuilderOutputPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isBuilderOutputShape(value)) return null;
  return value;
}

function parseObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return isObject(value) ? value : null;
}

function isBuilderOutputShape(value: unknown): value is BuilderOutputPayload {
  if (!isObject(value)) return false;
  if (!isBuilderOutcome(value["outcome"])) return false;
  if (!isStringArray(value["changed_files"])) return false;
  if (typeof value["summary"] !== "string") return false;
  if (!Array.isArray(value["verification"])) return false;
  if (!value["verification"].every(isVerification)) return false;
  return typeof value["blocker"] === "string";
}

function isVerification(value: unknown): value is BuilderOutputVerification {
  if (!isObject(value)) return false;
  if (typeof value["command"] !== "string") return false;
  if (!isVerificationOutcome(value["outcome"])) return false;
  return typeof value["summary"] === "string";
}

function isBuilderOutcome(value: unknown): value is BuilderOutputOutcome {
  return value === "success" || value === "failed_no_changes";
}

function isVerificationOutcome(value: unknown): value is BuilderVerificationOutcome {
  return value === "pass" || value === "fail" || value === "not_run";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
