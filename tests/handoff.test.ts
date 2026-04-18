import { describe, expect, it } from "vitest";

import { parseRunHandoff, serializeRunHandoff } from "../src/artifacts/handoff.js";
import type { RunHandoff } from "../src/workflow/index.js";

const handoff: RunHandoff = {
  version: 1,
  runId: "run-1",
  status: "shipped",
  workspacePath: "/Users/alice/projects/loom",
  branchName: "dev",
  changedFiles: ["src/workflow/engine.ts"],
  commitShas: ["abc123"],
  remotePushStatus: "pushed",
  verification: {
    outcome: "pass",
    summary: "ok",
    rawLogPath: "/tmp/verify.log",
    commandResults: [
      {
        name: "test",
        command: "pnpm test",
        outcome: "pass",
        rawLogPath: "/tmp/test.log",
      },
    ],
  },
  review: {
    outcome: "pass",
    findings: [],
    summary: "ok",
    rawLogPath: "/tmp/review.log",
  },
  linearStatus: "Done",
  recommendedNextAction: "merge",
};

describe("handoff schema", () => {
  it("round-trips the versioned handoff contract", () => {
    const serialized = serializeRunHandoff(handoff);

    expect(parseRunHandoff(JSON.parse(serialized))).toEqual(handoff);
  });

  it("rejects unknown handoff versions", () => {
    expect(() =>
      parseRunHandoff({
        ...handoff,
        version: 2,
      }),
    ).toThrow();
  });
});
