import {
  hasBuilderTextContract,
  parseBuilderOutputText,
  type BuilderOutputParseResult,
} from "./builder-output-parser.js";
import type { ClaudeWrapperMetadata } from "./claude-reviewer-output-parser.js";

export type ClaudeBuilderParseSource =
  | "structured_output"
  | "fallback_stdout"
  | "fallback_result"
  | "wrapper"
  | "none";

export interface ClaudeBuilderParseOutcome {
  parse: BuilderOutputParseResult;
  textContractPresent: boolean;
  source: ClaudeBuilderParseSource;
  wrapper: ClaudeWrapperMetadata;
  structuredOutput: unknown;
  resultText: string | null;
}

export function parseClaudeBuilderJsonOutput(stdout: string): ClaudeBuilderParseOutcome {
  const wrapper = readWrapper(stdout);
  const structuredParse = parseStructuredPayload(wrapper.structuredOutput);
  const stdoutContract = hasBuilderTextContract(stdout);
  const resultContract = wrapper.resultText !== null && hasBuilderTextContract(wrapper.resultText);
  const textContractPresent = stdoutContract || resultContract;

  if (structuredParse.ok) {
    return {
      parse: structuredParse,
      textContractPresent,
      source: "structured_output",
      wrapper: wrapper.metadata,
      structuredOutput: wrapper.structuredOutput,
      resultText: wrapper.resultText,
    };
  }

  if (stdoutContract) {
    return {
      parse: { ok: false, reason: "no_json" },
      textContractPresent,
      source: "fallback_stdout",
      wrapper: wrapper.metadata,
      structuredOutput: wrapper.structuredOutput,
      resultText: wrapper.resultText,
    };
  }

  if (resultContract) {
    return {
      parse: { ok: false, reason: "no_json" },
      textContractPresent,
      source: "fallback_result",
      wrapper: wrapper.metadata,
      structuredOutput: wrapper.structuredOutput,
      resultText: wrapper.resultText,
    };
  }

  if (wrapper.metadata.isError === true || isNonSuccessSubtype(wrapper.metadata.subtype)) {
    return {
      parse: { ok: false, reason: "invalid_shape" },
      textContractPresent,
      source: "wrapper",
      wrapper: wrapper.metadata,
      structuredOutput: wrapper.structuredOutput,
      resultText: wrapper.resultText,
    };
  }

  return {
    parse: structuredParse,
    textContractPresent,
    source: "none",
    wrapper: wrapper.metadata,
    structuredOutput: wrapper.structuredOutput,
    resultText: wrapper.resultText,
  };
}

interface WrapperRead {
  metadata: ClaudeWrapperMetadata;
  structuredOutput: unknown;
  resultText: string | null;
}

function readWrapper(stdout: string): WrapperRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      metadata: emptyMetadata(false),
      structuredOutput: null,
      resultText: null,
    };
  }

  const obj = readObject(parsed);
  if (!obj) {
    return {
      metadata: emptyMetadata(false),
      structuredOutput: null,
      resultText: null,
    };
  }

  const metadata: ClaudeWrapperMetadata = {
    jsonOk: true,
    isError: readBoolean(obj["is_error"]),
    subtype: typeof obj["subtype"] === "string" ? obj["subtype"] : null,
    hasStructuredOutput: Object.prototype.hasOwnProperty.call(obj, "structured_output"),
  };
  const structuredOutput = metadata.hasStructuredOutput ? obj["structured_output"] : null;
  const resultText = typeof obj["result"] === "string" ? obj["result"] : null;
  return { metadata, structuredOutput, resultText };
}

function parseStructuredPayload(value: unknown): BuilderOutputParseResult {
  if (value === undefined || value === null) {
    return { ok: false, reason: "no_json" };
  }
  return parseBuilderOutputText(JSON.stringify(value));
}

function emptyMetadata(jsonOk: boolean): ClaudeWrapperMetadata {
  return { jsonOk, isError: null, subtype: null, hasStructuredOutput: false };
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
