import { z } from "zod";

import type { RunHandoff } from "../workflow/index.js";

const verificationCommandResultSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.string().trim().min(1),
    outcome: z.enum(["pass", "fail"]),
    rawLogPath: z.string().trim().min(1),
  })
  .strict();

const verificationResultSchema = z
  .object({
    outcome: z.enum(["pass", "fail", "blocked"]),
    summary: z.string(),
    rawLogPath: z.string().trim().min(1),
    commandResults: z.array(verificationCommandResultSchema),
    failureReason: z.enum(["verification_failed", "env_failure"]).optional(),
  })
  .strict();

const reviewFindingSchema = z
  .object({
    severity: z.enum(["P0", "P1", "P2"]),
    title: z.string().trim().min(1),
    detail: z.string().trim().min(1),
    file: z.string().trim().min(1).optional(),
  })
  .strict();

const reviewResultSchema = z
  .object({
    outcome: z.enum(["pass", "revise", "blocked"]),
    findings: z.array(reviewFindingSchema),
    summary: z.string(),
    rawLogPath: z.string().trim().min(1),
  })
  .strict();

export const runHandoffSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().trim().min(1),
    status: z.enum([
      "queued",
      "preparing_workspace",
      "building",
      "verifying",
      "reviewing",
      "revising",
      "ready_for_ship",
      "shipped",
      "blocked",
      "failed",
      "cancelled",
    ]),
    workspacePath: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
    changedFiles: z.array(z.string().trim().min(1)),
    commitShas: z.array(z.string().trim().min(1)),
    remotePushStatus: z.enum(["pushed", "not_pushed"]),
    verification: verificationResultSchema.nullable(),
    review: reviewResultSchema.nullable(),
    linearStatus: z.string().trim().min(1),
    recommendedNextAction: z.enum(["merge", "blocked", "retry", "manual_review"]),
  })
  .strict() satisfies z.ZodType<RunHandoff>;

export function parseRunHandoff(value: unknown): RunHandoff {
  return runHandoffSchema.parse(value);
}

export function serializeRunHandoff(handoff: RunHandoff): string {
  return `${JSON.stringify(runHandoffSchema.parse(handoff), null, 2)}\n`;
}
