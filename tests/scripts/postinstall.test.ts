import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { daemonPath, systemdQuote, xmlEscape } from "../../scripts/postinstall.js";

describe("xmlEscape", () => {
  it("escapes the five XML special characters", () => {
    expect(xmlEscape("&")).toBe("&amp;");
    expect(xmlEscape("<")).toBe("&lt;");
    expect(xmlEscape(">")).toBe("&gt;");
    expect(xmlEscape('"')).toBe("&quot;");
    expect(xmlEscape("'")).toBe("&apos;");
  });

  it("escapes & before < and > so entities are not double-encoded", () => {
    expect(xmlEscape("&<>")).toBe("&amp;&lt;&gt;");
  });

  it("leaves a plain string untouched", () => {
    expect(xmlEscape("/opt/tools/bin")).toBe("/opt/tools/bin");
  });

  it("returns empty string for empty input", () => {
    expect(xmlEscape("")).toBe("");
  });
});

describe("systemdQuote", () => {
  it("wraps the value in double quotes", () => {
    expect(systemdQuote("/opt/tools/bin")).toBe('"/opt/tools/bin"');
  });

  it("escapes backslashes", () => {
    expect(systemdQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes embedded double quotes", () => {
    expect(systemdQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("doubles percent signs so systemd does not expand specifiers", () => {
    expect(systemdQuote("50%")).toBe('"50%%"');
  });

  it("escapes newline and carriage return", () => {
    expect(systemdQuote("a\nb\rc")).toBe('"a\\nb\\rc"');
  });

  it("leaves $ alone when escapeDollar is not set", () => {
    expect(systemdQuote("$VAR")).toBe('"$VAR"');
  });

  it("doubles $ when escapeDollar is true (regression for replaceAll $$ no-op)", () => {
    // Guards against a regression where `replaceAll("$", "$$")` silently
    // produced a single `$` because `$$` is a special replacement token.
    expect(systemdQuote("$VAR", { escapeDollar: true })).toBe('"$$VAR"');
    expect(systemdQuote("$$", { escapeDollar: true })).toBe('"$$$$"');
    expect(systemdQuote("a$b$c", { escapeDollar: true })).toBe('"a$$b$$c"');
  });

  it("combines escapes in the right order", () => {
    expect(systemdQuote('a\\b"c%d', { escapeDollar: true })).toBe('"a\\\\b\\"c%%d"');
  });
});

describe("daemonPath", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "PATH",
      "npm_config_prefix",
      "NPM_CONFIG_PREFIX",
      "PNPM_HOME",
      "BUN_INSTALL",
    ] as const) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  function setEnv(path: string) {
    process.env.PATH = path;
    for (const key of ["npm_config_prefix", "NPM_CONFIG_PREFIX", "PNPM_HOME", "BUN_INSTALL"]) {
      Reflect.deleteProperty(process.env, key);
    }
  }

  it("preserves the order of PATH entries relative to each other", () => {
    setEnv("/aaa/bin:/bbb/bin:/ccc/bin");
    const entries = daemonPath().split(":");
    const aaa = entries.indexOf("/aaa/bin");
    const bbb = entries.indexOf("/bbb/bin");
    const ccc = entries.indexOf("/ccc/bin");
    expect(aaa).toBeGreaterThanOrEqual(0);
    expect(bbb).toBeGreaterThan(aaa);
    expect(ccc).toBeGreaterThan(bbb);
  });

  it("dedupes repeated entries", () => {
    setEnv("/dup/bin:/dup/bin:/other/bin:/dup/bin");
    const entries = daemonPath().split(":");
    const occurrences = entries.filter((e) => e === "/dup/bin");
    expect(occurrences).toHaveLength(1);
  });

  it("includes sensible fallback defaults", () => {
    setEnv("/some/bin");
    const entries = daemonPath().split(":");
    expect(entries).toContain("/usr/bin");
    expect(entries).toContain("/bin");
  });

  it("returns a non-empty PATH even if process.env.PATH is empty", () => {
    setEnv("");
    const result = daemonPath();
    expect(result).not.toBe("");
    expect(result.split(":")).toContain("/usr/bin");
  });

  it("no entry in the output contains a path-separator or control character", () => {
    setEnv("/valid/bin:/also:weird:/another");
    for (const entry of daemonPath().split(":")) {
      expect(entry).not.toMatch(/[:\0\n\r]/);
      expect(entry).not.toBe("");
    }
  });

  it("drops entries containing colon, NUL, newline, or carriage return", () => {
    // A raw colon inside an entry is impossible in PATH (it's the separator),
    // but newline / NUL / CR can sneak in if an env var is crafted weirdly.
    setEnv("/safe/bin");
    process.env.PNPM_HOME = "/evil\nline";
    process.env.BUN_INSTALL = "/nul\0entry";
    const entries = daemonPath().split(":");
    expect(entries).toContain("/safe/bin");
    expect(entries.some((e) => e.includes("\n"))).toBe(false);
    expect(entries.some((e) => e.includes("\0"))).toBe(false);
  });

  it("includes npm_config_prefix/bin when set", () => {
    setEnv("/some/bin");
    process.env.npm_config_prefix = "/custom/npm-prefix";
    expect(daemonPath().split(":")).toContain("/custom/npm-prefix/bin");
  });

  it("includes PNPM_HOME and BUN_INSTALL/bin when set", () => {
    setEnv("/some/bin");
    process.env.PNPM_HOME = "/custom/pnpm-home";
    process.env.BUN_INSTALL = "/custom/bun";
    const entries = daemonPath().split(":");
    expect(entries).toContain("/custom/pnpm-home");
    expect(entries).toContain("/custom/bun/bin");
  });
});
