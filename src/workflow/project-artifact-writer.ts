import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProjectArtifactWriter {
  writeText(path: string, contents: string): Promise<void>;
}

export class FsProjectArtifactWriter implements ProjectArtifactWriter {
  async writeText(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

export class NoopProjectArtifactWriter implements ProjectArtifactWriter {
  async writeText(): Promise<void> {
    // no-op; used when the coordinator runs without disk-backed artifacts
  }
}
