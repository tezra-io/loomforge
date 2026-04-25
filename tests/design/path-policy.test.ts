import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRepoRootAllowed,
  assertRequirementPathAllowed,
  buildDesignPathPolicy,
} from "../../src/design/path-policy.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `loom-path-policy-${prefix}-`));
}

describe("design path policy", () => {
  it("allows paths inside the configured repoRoot", async () => {
    const root = await tmp("root");
    const policy = buildDesignPathPolicy(root);
    expect(() => assertRepoRootAllowed(policy, join(root, "proj"))).not.toThrow();
    expect(() => assertRepoRootAllowed(policy, root)).not.toThrow();
  });

  it("rejects paths outside the configured safe roots", async () => {
    const root = await tmp("root-outside");
    const policy = buildDesignPathPolicy(root);
    expect(() => assertRepoRootAllowed(policy, "/tmp/other-place")).toThrow(
      /outside the configured safe roots/,
    );
  });

  it("throws a helpful error when no safe roots are configured", () => {
    const policy = buildDesignPathPolicy(null);
    expect(() => assertRepoRootAllowed(policy, "/anywhere")).toThrow(/has no configured repoRoot/);
    expect(() => assertRequirementPathAllowed(policy, "/anywhere")).toThrow(
      /no configured safe roots for requirement/,
    );
  });

  it("treats registered project repoRoots as valid requirement roots", async () => {
    const designRoot = await tmp("design-root");
    const projectRoot = await tmp("project-root");
    const policy = buildDesignPathPolicy(designRoot, { repoRoots: [projectRoot] });
    expect(() => assertRequirementPathAllowed(policy, join(projectRoot, "req.md"))).not.toThrow();
    expect(() => assertRequirementPathAllowed(policy, join(designRoot, "req.md"))).not.toThrow();
    expect(() => assertRequirementPathAllowed(policy, "/tmp/definitely-elsewhere")).toThrow();
  });

  it("does not confuse prefix-matching siblings", async () => {
    const parent = await tmp("prefix");
    const policy = buildDesignPathPolicy(join(parent, "foo"));
    expect(() => assertRepoRootAllowed(policy, join(parent, "foobar"))).toThrow(
      /outside the configured safe roots/,
    );
  });
});
