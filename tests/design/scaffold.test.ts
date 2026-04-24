import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { ensureScaffold } from "../../src/scaffolding/scaffold.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `loom-scaffold-${prefix}-`));
}

describe("ensureScaffold", () => {
  it("initialises a fresh directory with git, gitignore, CLAUDE.md, AGENTS.md, and an initial commit", async () => {
    const parent = await tmp("fresh");
    const repoPath = join(parent, "new-proj");

    const result = await ensureScaffold({
      repoPath,
      slug: "new-proj",
      designDocRelativePath: "docs/design/new-proj-design.md",
      defaultBranch: "main",
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") return;
    expect(result.initialized).toBe(true);

    const gitignore = await readFile(join(repoPath, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("docs/design/new-proj-design.md");

    const claude = await readFile(join(repoPath, "CLAUDE.md"), "utf8");
    expect(claude).toContain("new-proj");

    const agents = await readFile(join(repoPath, "AGENTS.md"), "utf8");
    expect(agents).toContain("new-proj");

    const log = await execa("git", ["log", "--oneline"], { cwd: repoPath });
    expect(log.stdout).toContain("initial loomforge scaffold");
  });

  it("rejects non-empty directories that are not git repos", async () => {
    const repoPath = await tmp("dirty");
    await writeFile(join(repoPath, "random.txt"), "hi", "utf8");

    const result = await ensureScaffold({
      repoPath,
      slug: "dirty-proj",
      designDocRelativePath: "docs/design/dirty-proj-design.md",
      defaultBranch: "main",
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toBe("non_empty_non_git_dir");
    expect(result.summary).toContain("not a git repo");
  });

  it("re-uses an existing git repo without re-initialising it", async () => {
    const repoPath = await tmp("existing");
    await execa("git", ["init", "-b", "main"], { cwd: repoPath });
    await mkdir(join(repoPath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "x.txt"), "keep me", "utf8");

    const result = await ensureScaffold({
      repoPath,
      slug: "existing-proj",
      designDocRelativePath: "docs/design/existing-proj-design.md",
      defaultBranch: "main",
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") return;
    expect(result.initialized).toBe(false);

    const kept = await readFile(join(repoPath, "src", "x.txt"), "utf8");
    expect(kept).toBe("keep me");
  });
});
