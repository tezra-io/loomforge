import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  appendLoomYamlProject,
  defaultVerificationPlaceholder,
  type LoomYamlProjectEntry,
} from "../../src/design/loom-yaml-appender.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "loom-yaml-append-"));
}

function sampleEntry(slug: string): LoomYamlProjectEntry {
  return {
    slug,
    repoRoot: `/repos/${slug}`,
    defaultBranch: "main",
    devBranch: "dev",
    linearTeamKey: "ENG",
    linearProjectName: slug,
    builder: "codex",
    reviewer: "claude",
    verification: defaultVerificationPlaceholder(),
  };
}

describe("appendLoomYamlProject", () => {
  it("creates the file with the new project when it does not exist", async () => {
    const dir = await tmp();
    const configPath = join(dir, "loom.yaml");

    const result = await appendLoomYamlProject(configPath, sampleEntry("alpha"));

    expect(result.outcome).toBe("appended");
    const doc = parseYaml(await readFile(configPath, "utf8")) as {
      projects: Array<{ slug: string }>;
    };
    expect(doc.projects.map((p) => p.slug)).toEqual(["alpha"]);
  });

  it("appends to an existing projects list without touching other entries", async () => {
    const dir = await tmp();
    const configPath = join(dir, "loom.yaml");
    await writeFile(
      configPath,
      "projects:\n  - slug: existing\n    repoRoot: /repos/existing\n",
      "utf8",
    );

    const result = await appendLoomYamlProject(configPath, sampleEntry("newcomer"));

    expect(result.outcome).toBe("appended");
    const doc = parseYaml(await readFile(configPath, "utf8")) as {
      projects: Array<{ slug: string }>;
    };
    expect(doc.projects.map((p) => p.slug)).toEqual(["existing", "newcomer"]);
  });

  it("reports already_present for a slug that is already registered", async () => {
    const dir = await tmp();
    const configPath = join(dir, "loom.yaml");
    await appendLoomYamlProject(configPath, sampleEntry("dup"));

    const second = await appendLoomYamlProject(configPath, sampleEntry("dup"));

    expect(second.outcome).toBe("already_present");
  });

  it("fails when the existing YAML is not a mapping", async () => {
    const dir = await tmp();
    const configPath = join(dir, "loom.yaml");
    await writeFile(configPath, "- just\n- a\n- list\n", "utf8");

    const result = await appendLoomYamlProject(configPath, sampleEntry("x"));

    expect(result.outcome).toBe("failed");
  });
});
