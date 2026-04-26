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

  it("loomforge run posts to /runs/adhoc with project + prompt and prints the payload", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      captured.url = typeof input === "string" ? input : input.toString();
      captured.init = init;
      return new Response(
        JSON.stringify({
          runId: "run-1",
          issueId: "TEZ-100",
          linearUrl: "https://linear.app/x/issue/TEZ-100",
          queuePosition: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const written: string[] = [];
    const program = createCliProgram({
      write: (text) => {
        written.push(text);
      },
      fetch: fakeFetch,
    });

    await program.parseAsync(["run", "Fix the typo in README", "--project", "loom"], {
      from: "user",
    });

    expect(captured.url).toContain("/runs/adhoc");
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(String(captured.init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toEqual({ project: "loom", prompt: "Fix the typo in README" });
    expect(written.join("")).toContain("TEZ-100");
  });

  it("loomforge run requires --project (no CWD fallback)", async () => {
    const program = createCliProgram({
      write: () => {},
      fetch: (async () => new Response("{}")) as typeof fetch,
    });
    program.exitOverride();
    program.commands.forEach((c) => c.exitOverride());

    await expect(program.parseAsync(["run", "x"], { from: "user" })).rejects.toThrow(/project/i);
  });
});
