import type { ReviewFinding } from "../workflow/types.js";

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

const MAX_CANDIDATES = 16;

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

function extractJsonCandidates(text: string): string[] {
  const results: string[] = [];
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  for (const match of text.matchAll(fencePattern)) {
    const block = match[1]?.trim();
    if (block) results.push(block);
    if (results.length >= MAX_CANDIDATES) return results;
  }

  for (const block of balancedBraceBlocks(text)) {
    results.push(block);
    if (results.length >= MAX_CANDIDATES) break;
  }

  return results;
}

function recoverTruncatedJson(text: string): string | null {
  const stack: Array<"{" | "["> = [];
  let outerStart = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0 && char === "{") outerStart = i;
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.length === 0) continue;
      stack.pop();
      if (stack.length === 0) outerStart = -1;
    }
  }

  if (inString) return null;
  if (outerStart < 0 || stack.length === 0) return null;

  const body = text.slice(outerStart).replace(/[\s,]+$/, "");
  const closes = stack
    .slice()
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
  return body + closes;
}

function balancedBraceBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
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
