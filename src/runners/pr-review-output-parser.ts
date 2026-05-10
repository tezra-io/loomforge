import type { PrReviewFinding } from "../workflow/types.js";

export type PrReviewOutcome = "pass" | "findings" | "blocked";

export interface PrReviewPayload {
  outcome: PrReviewOutcome;
  findings: PrReviewFinding[];
  summary: string;
}

export type PrReviewParseReason = "no_json" | "invalid_shape";

export type PrReviewParseResult =
  | { ok: true; payload: PrReviewPayload }
  | { ok: false; reason: PrReviewParseReason };

export function parsePrReviewerOutput(stdout: string): PrReviewParseResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "no_json" };
  }

  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid_shape" };
  }

  const obj = value as Record<string, unknown>;
  const candidate = Object.prototype.hasOwnProperty.call(obj, "structured_output")
    ? obj["structured_output"]
    : value;
  const payload = readPrReviewPayload(candidate);
  if (!payload) return { ok: false, reason: "invalid_shape" };
  return { ok: true, payload };
}

function readPrReviewPayload(value: unknown): PrReviewPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const outcome = obj["outcome"];
  if (typeof outcome !== "string" || !["pass", "findings", "blocked"].includes(outcome)) {
    return null;
  }
  if (!Array.isArray(obj["findings"])) return null;
  if (typeof obj["summary"] !== "string") return null;

  return {
    outcome: outcome as PrReviewOutcome,
    findings: obj["findings"].filter(isValidFinding).map(normalizeFinding),
    summary: obj["summary"],
  };
}

function isValidFinding(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const severity = obj["severity"];
  if (typeof severity !== "string" || !["P0", "P1", "P2"].includes(severity)) {
    return false;
  }
  if (typeof obj["title"] !== "string") return false;
  if (typeof obj["detail"] !== "string") return false;
  return true;
}

function normalizeFinding(raw: Record<string, unknown>): PrReviewFinding {
  const finding: PrReviewFinding = {
    severity: raw["severity"] as "P0" | "P1" | "P2",
    title: raw["title"] as string,
    detail: raw["detail"] as string,
  };
  if (typeof raw["file"] === "string") finding.file = raw["file"];
  if (Number.isInteger(raw["startLine"])) {
    finding.startLine = raw["startLine"] as number;
  }
  if (Number.isInteger(raw["endLine"])) {
    finding.endLine = raw["endLine"] as number;
  }
  return finding;
}
