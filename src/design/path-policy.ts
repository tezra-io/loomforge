import { resolve, sep } from "node:path";

export interface DesignPathPolicy {
  allowedRepoRoots: string[];
  allowedRequirementRoots: string[];
}

export function buildDesignPathPolicy(
  designConfigRepoRoot: string | null,
  extra: { repoRoots?: string[]; requirementRoots?: string[] } = {},
): DesignPathPolicy {
  const repoRoots = new Set<string>();
  if (designConfigRepoRoot) repoRoots.add(resolve(designConfigRepoRoot));
  for (const root of extra.repoRoots ?? []) repoRoots.add(resolve(root));

  const requirementRoots = new Set<string>();
  for (const root of repoRoots) requirementRoots.add(root);
  for (const root of extra.requirementRoots ?? []) requirementRoots.add(resolve(root));

  return {
    allowedRepoRoots: [...repoRoots],
    allowedRequirementRoots: [...requirementRoots],
  };
}

export function assertRepoRootAllowed(policy: DesignPathPolicy, candidate: string): void {
  if (policy.allowedRepoRoots.length === 0) {
    throw new Error(
      "Design flow has no configured repoRoot. Add 'design.repoRoot' to ~/.loomforge/config.yaml " +
        "before starting a run.",
    );
  }
  const resolved = resolve(candidate);
  if (!policy.allowedRepoRoots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `repoRoot "${candidate}" is outside the configured safe roots: ` +
        policy.allowedRepoRoots.join(", "),
    );
  }
}

export function assertRequirementPathAllowed(policy: DesignPathPolicy, candidate: string): void {
  if (policy.allowedRequirementRoots.length === 0) {
    throw new Error(
      "Design flow has no configured safe roots for requirement paths. Add 'design.repoRoot' " +
        "to ~/.loomforge/config.yaml or use --requirement-text.",
    );
  }
  const resolved = resolve(candidate);
  if (!policy.allowedRequirementRoots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `requirementPath "${candidate}" is outside the configured safe roots: ` +
        policy.allowedRequirementRoots.join(", "),
    );
  }
}

function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}
