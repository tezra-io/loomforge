import { describe, expect, it } from "vitest";

import { resolveLinearApiKey } from "../../src/app/runtime.js";

describe("resolveLinearApiKey", () => {
  it("prefers the configured key when it is not the scaffold placeholder", () => {
    expect(resolveLinearApiKey("lin_api_config", { LINEAR_API_KEY: "lin_api_env" })).toBe(
      "lin_api_config",
    );
  });

  it("falls back to LINEAR_API_KEY when config still has the scaffold placeholder", () => {
    expect(resolveLinearApiKey("lin_api_YOUR_KEY_HERE", { LINEAR_API_KEY: "lin_api_env" })).toBe(
      "lin_api_env",
    );
  });

  it("returns undefined when neither config nor env provides a usable key", () => {
    expect(resolveLinearApiKey("lin_api_YOUR_KEY_HERE", {})).toBeUndefined();
  });
});
