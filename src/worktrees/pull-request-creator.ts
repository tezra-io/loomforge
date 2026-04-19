import { execa } from "execa";

import type { ProjectConfig } from "../config/index.js";
import type { PullRequestCreator } from "../workflow/types.js";

export class GhPullRequestCreator implements PullRequestCreator {
  async createPr(
    project: ProjectConfig,
    title: string,
    body: string,
  ): Promise<{ url: string } | null> {
    const push = await execa("git", ["push", "-u", "origin", project.devBranch], {
      cwd: project.repoRoot,
      reject: false,
    });
    if (push.exitCode !== 0) {
      return null;
    }

    const result = await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        project.defaultBranch,
        "--head",
        project.devBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: project.repoRoot, reject: false },
    );

    if (result.exitCode !== 0) {
      return null;
    }

    const url = result.stdout.trim();
    return { url };
  }
}
