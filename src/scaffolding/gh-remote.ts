import { execa } from "execa";

import { childProcessEnv } from "../runners/path-env.js";

export interface GhRemoteOutcome {
  outcome: "created";
  remoteUrl: string;
}

export interface GhRemoteSkipped {
  outcome: "skipped";
  reason: "gh_missing" | "gh_unauthenticated" | "already_has_remote";
}

export interface GhRemoteFailure {
  outcome: "failed";
  reason: string;
}

export type GhRemoteResult = GhRemoteOutcome | GhRemoteSkipped | GhRemoteFailure;

export async function ensureGithubRemote(
  repoPath: string,
  slug: string,
  org?: string | null,
): Promise<GhRemoteResult> {
  const existing = await readRemoteUrl(repoPath);
  if (existing) {
    return { outcome: "skipped", reason: "already_has_remote" };
  }

  if (!(await ghAvailable())) {
    return { outcome: "skipped", reason: "gh_missing" };
  }

  if (!(await ghAuthenticated())) {
    return { outcome: "skipped", reason: "gh_unauthenticated" };
  }

  const repoName = org && org.trim().length > 0 ? `${org.trim()}/${slug}` : slug;
  const create = await execa(
    "gh",
    ["repo", "create", repoName, "--private", "--source", ".", "--push", "--remote", "origin"],
    { cwd: repoPath, env: childProcessEnv(), reject: false },
  );

  if (create.exitCode !== 0) {
    return {
      outcome: "failed",
      reason: create.stderr.trim() || create.stdout.trim() || "gh repo create failed",
    };
  }

  const remoteUrl = await readRemoteUrl(repoPath);
  if (!remoteUrl) {
    return { outcome: "failed", reason: "Remote created but origin URL not detected" };
  }

  return { outcome: "created", remoteUrl };
}

export async function readRemoteUrl(repoPath: string): Promise<string | null> {
  const result = await execa("git", ["remote", "get-url", "origin"], {
    cwd: repoPath,
    env: childProcessEnv(),
    reject: false,
  });
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}

async function ghAvailable(): Promise<boolean> {
  const result = await execa("gh", ["--version"], {
    env: childProcessEnv(),
    reject: false,
  });
  return result.exitCode === 0;
}

async function ghAuthenticated(): Promise<boolean> {
  const result = await execa("gh", ["auth", "status"], {
    env: childProcessEnv(),
    reject: false,
  });
  return result.exitCode === 0;
}
