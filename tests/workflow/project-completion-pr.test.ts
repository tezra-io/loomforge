import { describe, expect, it } from "vitest";

import { buildMergePr } from "../../src/workflow/project-completion-pr.js";

describe("buildMergePr", () => {
  it("builds a descriptive title and body listing shipped issues with titles", () => {
    const { title, body } = buildMergePr("fermix", "main", [
      { id: "TEZ-378", title: "Switch config loader to the new schema" },
      { id: "TEZ-380", title: "Fix auth middleware crash on empty body" },
    ]);

    expect(title).toBe("[fermix] Ship 2 issues to main");
    expect(body).toContain("Ships 2 issues from `dev` into `main`.");
    expect(body).toContain("- **TEZ-378** — Switch config loader to the new schema");
    expect(body).toContain("- **TEZ-380** — Fix auth middleware crash on empty body");
    expect(body).not.toContain("Blocked");
    expect(body).not.toContain("Failed");
  });

  it("uses singular wording when only one issue ships", () => {
    const { title, body } = buildMergePr("fermix", "main", [
      { id: "TEZ-401", title: "Add release notes template" },
    ]);

    expect(title).toBe("[fermix] Ship 1 issue to main");
    expect(body).toContain("Ships 1 issue from `dev` into `main`.");
  });

  it("falls back to the bare issue ID when no title is available", () => {
    const { body } = buildMergePr("fermix", "main", [{ id: "TEZ-999", title: null }]);

    expect(body).toContain("- **TEZ-999**");
    expect(body).not.toContain("— null");
    expect(body).not.toContain("— undefined");
  });

  it("trims whitespace from issue titles", () => {
    const { body } = buildMergePr("fermix", "main", [{ id: "TEZ-1", title: "  Ship it  " }]);

    expect(body).toContain("- **TEZ-1** — Ship it");
  });
});
