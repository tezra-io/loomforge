import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ArtifactStore } from "../../src/artifacts/index.js";
import type { IssueSnapshot, RunHandoff } from "../../src/workflow/index.js";

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "loom-artifacts-"));
  store = new ArtifactStore(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const snapshot: IssueSnapshot = {
  identifier: "TEZ-42",
  title: "Fix the widget",
  description: "It is broken",
  acceptanceCriteria: "It works",
  labels: ["bug"],
  comments: ["Please fix"],
  priority: "High",
};

const handoff: RunHandoff = {
  version: 1,
  runId: "run-1",
  status: "shipped",
  workspacePath: "/repos/test",
  branchName: "dev",
  changedFiles: ["src/main.ts"],
  commitShas: ["abc123"],
  remotePushStatus: "pushed",
  verification: null,
  review: null,
  linearStatus: "Done",
  recommendedNextAction: "merge",
};

describe("ArtifactStore", () => {
  it("writes and reads an issue snapshot", async () => {
    const meta = await store.writeIssueSnapshot("run-1", snapshot);

    expect(meta.kind).toBe("issue_snapshot");
    expect(meta.path).toBe(join("run-1", "issue-snapshot.json"));

    const content = await readFile(join(tmpDir, "runs", meta.path), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.identifier).toBe("TEZ-42");
    expect(parsed.title).toBe("Fix the widget");
  });

  it("writes and reads a handoff", async () => {
    const meta = await store.writeHandoff("run-1", handoff);

    expect(meta.kind).toBe("handoff");
    expect(meta.path).toBe(join("run-1", "handoff.json"));
    expect(meta.metadata).toEqual({ version: 1 });

    const content = await readFile(join(tmpDir, "runs", meta.path), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.status).toBe("shipped");
    expect(parsed.recommendedNextAction).toBe("merge");
  });

  it("reads content back by relative path", async () => {
    const meta = await store.writeIssueSnapshot("run-1", snapshot);
    const content = await store.readContent(meta.path);

    expect(content).not.toBeNull();
    const parsed = JSON.parse(content ?? "{}");
    expect(parsed.identifier).toBe("TEZ-42");
  });

  it("returns null for nonexistent paths", async () => {
    const content = await store.readContent("nonexistent/file.json");
    expect(content).toBeNull();
  });

  it("creates nested directories as needed", async () => {
    const meta = await store.writeIssueSnapshot("deep-run-id", snapshot);
    const content = await store.readContent(meta.path);
    expect(content).not.toBeNull();
  });
});
