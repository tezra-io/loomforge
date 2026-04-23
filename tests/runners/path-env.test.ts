import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import { executablePath } from "../../src/runners/path-env.js";

describe("executablePath", () => {
  it("preserves the caller PATH before adding common tool locations", () => {
    const home = "/Users/alice";
    const existing = ["/custom/bin", "/usr/bin"];
    const value = executablePath({
      HOME: home,
      PATH: existing.join(delimiter),
    });
    const entries = value.split(delimiter);

    expect(entries.slice(0, 2)).toEqual(existing);
    expect(entries).toContain(join(home, ".npm-global", "bin"));
    expect(entries).toContain(join(home, ".local", "bin"));
    expect(entries).toContain("/opt/homebrew/bin");
    expect(entries).toContain("/usr/local/bin");
  });

  it("adds package-manager tool homes and removes duplicates", () => {
    const home = "/home/alice";
    const npmPrefix = join(home, ".npm-global");
    const value = executablePath({
      HOME: home,
      PATH: `/bin${delimiter}/bin${delimiter}`,
      npm_config_prefix: npmPrefix,
      PNPM_HOME: join(home, ".pnpm-home"),
      BUN_INSTALL: join(home, ".bun-install"),
    });
    const entries = value.split(delimiter);

    expect(entries.filter((entry) => entry === "/bin")).toHaveLength(1);
    expect(entries).toContain(join(npmPrefix, "bin"));
    expect(entries).toContain(join(home, ".pnpm-home"));
    expect(entries).toContain(join(home, ".bun-install", "bin"));
  });
});
