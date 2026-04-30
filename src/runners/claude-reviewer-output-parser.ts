import {
  parseReviewerOutput,
  readReviewPayload,
  type ReviewParseResult,
} from "./review-output-parser.js";

export type ClaudeReviewParseSource =
  | "structured_output"
  | "fallback_stdout"
  | "fallback_result"
  | "wrapper";

export interface ClaudeWrapperMetadata {
  jsonOk: boolean;
  isError: boolean | null;
  subtype: string | null;
  hasStructuredOutput: boolean;
}

export interface ClaudeReviewParseOutcome {
  parse: ReviewParseResult;
  source: ClaudeReviewParseSource;
  wrapper: ClaudeWrapperMetadata;
  structuredOutput: unknown;
}

export function parseClaudeJsonOutput(stdout: string): ClaudeReviewParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fallbackStdout(stdout, wrapperMetadata(false, null));
  }

  const obj = readObject(parsed);
  if (!obj) return fallbackStdout(stdout, wrapperMetadata(false, null));

  const metadata = wrapperMetadata(true, obj);
  const structuredOutput = metadata.hasStructuredOutput ? obj["structured_output"] : null;
  const payload = readReviewPayload(structuredOutput);
  if (payload) {
    return {
      parse: { ok: true, payload },
      source: "structured_output",
      wrapper: metadata,
      structuredOutput,
    };
  }

  if (metadata.isError === true || isNonSuccessSubtype(metadata.subtype)) {
    return {
      parse: { ok: false, reason: "invalid_shape" },
      source: "wrapper",
      wrapper: metadata,
      structuredOutput,
    };
  }

  const stdoutParse = parseReviewerOutput(stdout);
  if (stdoutParse.ok) {
    return { parse: stdoutParse, source: "fallback_stdout", wrapper: metadata, structuredOutput };
  }

  const resultText = obj["result"];
  if (typeof resultText !== "string") {
    return { parse: stdoutParse, source: "fallback_stdout", wrapper: metadata, structuredOutput };
  }

  const resultParse = parseReviewerOutput(resultText);
  if (resultParse.ok) {
    return { parse: resultParse, source: "fallback_result", wrapper: metadata, structuredOutput };
  }

  return { parse: stdoutParse, source: "fallback_stdout", wrapper: metadata, structuredOutput };
}

function fallbackStdout(stdout: string, wrapper: ClaudeWrapperMetadata): ClaudeReviewParseOutcome {
  return {
    parse: parseReviewerOutput(stdout),
    source: "fallback_stdout",
    wrapper,
    structuredOutput: null,
  };
}

function wrapperMetadata(
  jsonOk: boolean,
  obj: Record<string, unknown> | null,
): ClaudeWrapperMetadata {
  if (!obj) {
    return {
      jsonOk,
      isError: null,
      subtype: null,
      hasStructuredOutput: false,
    };
  }

  return {
    jsonOk,
    isError: readBoolean(obj["is_error"]),
    subtype: typeof obj["subtype"] === "string" ? obj["subtype"] : null,
    hasStructuredOutput: Object.prototype.hasOwnProperty.call(obj, "structured_output"),
  };
}

function readBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function isNonSuccessSubtype(subtype: string | null): boolean {
  return typeof subtype === "string" && subtype.length > 0 && subtype !== "success";
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}
