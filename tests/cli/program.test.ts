import { describe, expect, it, vi } from "vitest";

import { createCliProgram } from "../../src/cli/program.js";
import type { RunSetupOptions } from "../../src/cli/setup.js";

describe("createCliProgram", () => {
  it("routes the setup command through injected dependencies", async () => {
    const writes: string[] = [];
    const runSetup = vi.fn(async (options?: RunSetupOptions) => {
      options?.write?.("setup output\n");
    });
    const program = createCliProgram({
      runSetup,
      write: (text) => {
        writes.push(text);
      },
    });

    await program.parseAsync(["setup"], { from: "user" });

    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("setup output");
  });
});
