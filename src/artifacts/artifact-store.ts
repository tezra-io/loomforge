import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMeta, IssueSnapshot, RunHandoff } from "../workflow/index.js";
import { serializeRunHandoff } from "./handoff.js";

export class ArtifactStore {
  private readonly baseDir: string;

  constructor(dataRoot: string) {
    this.baseDir = join(dataRoot, "runs");
  }

  async writeIssueSnapshot(runId: string, snapshot: IssueSnapshot): Promise<ArtifactMeta> {
    const relPath = join(runId, "issue-snapshot.json");
    await this.write(relPath, JSON.stringify(snapshot, null, 2) + "\n");
    return { kind: "issue_snapshot", path: relPath, metadata: {} };
  }

  async writeHandoff(runId: string, handoff: RunHandoff): Promise<ArtifactMeta> {
    const relPath = join(runId, "handoff.json");
    await this.write(relPath, serializeRunHandoff(handoff));
    return { kind: "handoff", path: relPath, metadata: { version: handoff.version } };
  }

  async readContent(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.baseDir, relPath), "utf8");
    } catch {
      return null;
    }
  }

  private async write(relPath: string, content: string): Promise<void> {
    const absPath = join(this.baseDir, relPath);
    const dir = join(absPath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(absPath, content, "utf8");
  }
}
