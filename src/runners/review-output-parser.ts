import type { ReviewFinding } from "../workflow/types.js";
import { extractJsonCandidates, recoverTruncatedJson } from "./json-output-parser.js";

export type ReviewOutcome = "pass" | "revise" | "blocked";

export interface ReviewPayload {
  outcome: ReviewOutcome;
  findings: ReviewFinding[];
  summary: string;
}

export type ReviewParseReason = "no_json" | "invalid_shape";

export type ReviewParseResult =
  | { ok: true; payload: ReviewPayload }
  | { ok: false; reason: ReviewParseReason };

export function parseReviewerOutput(stdout: string): ReviewParseResult {
  const candidates = extractJsonCandidates(stdout);

  for (const candidate of candidates) {
    const parsed = tryParseReview(candidate);
    if (parsed) return { ok: true, payload: parsed };
  }

  const recovered = recoverTruncatedJson(stdout);
  if (recovered) {
    const parsed = tryParseReview(recovered);
    if (parsed) return { ok: true, payload: parsed };
  }

  if (candidates.length === 0) return { ok: false, reason: "no_json" };
  return { ok: false, reason: "invalid_shape" };
}

function tryParseReview(text: string): ReviewPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isReviewShape(value)) return null;
  return {
    outcome: value.outcome,
    findings: value.findings.filter(isValidFinding),
    summary: value.summary,
  };
}

interface ReviewShape {
  outcome: ReviewOutcome;
  findings: unknown[];
  summary: string;
}

function isReviewShape(value: unknown): value is ReviewShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const outcome = obj["outcome"];
  if (typeof outcome !== "string" || !["pass", "revise", "blocked"].includes(outcome)) return false;
  if (!Array.isArray(obj["findings"])) return false;
  if (typeof obj["summary"] !== "string") return false;
  return true;
}

function isValidFinding(value: unknown): value is ReviewFinding {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const severity = obj["severity"];
  if (typeof severity !== "string" || !["P0", "P1", "P2"].includes(severity)) return false;
  if (typeof obj["title"] !== "string") return false;
  if (typeof obj["detail"] !== "string") return false;
  return true;
}
