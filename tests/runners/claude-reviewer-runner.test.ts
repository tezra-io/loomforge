import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ReviewerRunnerImpl } from "../../src/runners/claude-reviewer-runner.js";
import type { WorkflowStepContext } from "../../src/workflow/types.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";

let tmpDir: string;
let repoDir: string;
let artifactDir: string;
let binDir: string;
let originalPath: string | undefined;
let originalReviewerOutput: string | undefined;
let originalCodexReviewerOutput: string | undefined;

function createContext(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  const project =
    parseProjectConfigRegistry(
      `
projects:
  - slug: test
    repoRoot: ${repoDir}
    defaultBranch: main
    timeouts:
      reviewerMs: 10000
    verification:
      commands:
        - name: test
          command: echo ok
`,
      { homeDir: tmpDir },
    ).projects[0] ??
    (() => {
      throw new Error("no project");
    })();

  return {
    run: {
      id: "run-1",
      projectSlug: "test",
      issueId: "TEZ-1",
      source: "linear",
      state: "reviewing",
      failureReason: null,
      revisionCount: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      queuePosition: null,
      issueSnapshot: null,
      workspace: null,
      attempts: [],
      events: [],
      handoff: null,
    },
    project,
    issue: {
      identifier: "TEZ-1",
      title: "Test issue",
      description: "Fix the thing",
      acceptanceCriteria: "It works",
      labels: [],
      comments: [],
      priority: null,
    },
    workspace: { path: repoDir, branchName: "dev" },
    attempt: {
      id: "attempt-1",
      runId: "run-1",
      attemptNumber: 1,
      outcome: null,
      builderResult: null,
      verificationResult: null,
      reviewResult: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    revisionInput: null,
    ...overrides,
  };
}

async function writeFakeBinary(name: string, script: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${script}`, "utf8");
  await chmod(path, 0o755);
}

beforeEach(async () => {
  originalPath = process.env.PATH;
  originalReviewerOutput = process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT;
  originalCodexReviewerOutput = process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT;
  tmpDir = await mkdtemp(join(tmpdir(), "loom-claude-"));
  repoDir = join(tmpDir, "repo");
  artifactDir = join(tmpDir, "artifacts");
  binDir = join(tmpDir, "bin");

  await execa("mkdir", ["-p", binDir]);
  await execa("mkdir", ["-p", artifactDir]);
  await execa("git", ["init", repoDir]);
  await execa("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execa("git", ["-C", repoDir, "config", "user.name", "Test"]);
  await execa("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"]);
  await execa("git", ["-C", repoDir, "checkout", "-b", "dev"]);

  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT;
  delete process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalReviewerOutput === undefined) {
    delete process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT;
  } else {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = originalReviewerOutput;
  }
  if (originalCodexReviewerOutput === undefined) {
    delete process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT;
  } else {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = originalCodexReviewerOutput;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ReviewerRunnerImpl", () => {
  it("returns pass when reviewer outputs passing JSON", async () => {
    const output = JSON.stringify({
      outcome: "pass",
      findings: [],
      summary: "Looks good",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe("Looks good");
  });

  it("returns revise with findings when reviewer requests changes", async () => {
    const output = JSON.stringify({
      outcome: "revise",
      findings: [
        {
          severity: "P0",
          title: "Missing check",
          detail: "No null check on input",
          file: "src/main.ts",
        },
        { severity: "P2", title: "Style", detail: "Consider renaming" },
      ],
      summary: "Needs fixes",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.at(0)?.severity).toBe("P0");
    expect(result.findings.at(1)?.severity).toBe("P2");
  });

  it("returns blocked when reviewer outputs invalid JSON", async () => {
    await writeFakeBinary("claude", "echo 'I could not review this code'");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("did not contain valid JSON");
  });

  it("returns blocked when reviewer exits non-zero", async () => {
    await writeFakeBinary("claude", "echo 'some error' >&2; exit 1");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("exit");
    expect(result.failureReason).toBeUndefined();
  });

  it("returns blocked with runner_auth_missing when reviewer exits with auth error", async () => {
    await writeFakeBinary("claude", "echo 'Unauthorized: token expired' >&2; exit 1");

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("runner_auth_missing");
    expect(result.summary).toContain("authentication failed");
  });

  it("returns blocked on timeout", async () => {
    await writeFakeBinary("claude", "exec sleep 60");

    const project = createContext().project;
    project.timeouts.reviewerMs = 500;
    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext({ project }));

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("timed out");
  }, 15_000);

  it("extracts JSON from markdown fences", async () => {
    const json = JSON.stringify({ outcome: "pass", findings: [], summary: "OK" });
    await writeFakeBinary(
      "claude",
      `echo '\\x60\\x60\\x60json'; echo '${json}'; echo '\\x60\\x60\\x60'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
  });

  it("extracts JSON even when the reviewer emits prose with brace placeholders first", async () => {
    const json = JSON.stringify({
      outcome: "revise",
      findings: [{ severity: "P0", title: "Missing null check", detail: "Guard input" }],
      summary: "Needs fixes",
    });
    await writeFakeBinary(
      "claude",
      `printf '%s\\n%s\\n' 'Looking at the diff, I see issues with {variable} references.' '${json}'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.title).toBe("Missing null check");
  });

  it("filters out malformed findings", async () => {
    const output = JSON.stringify({
      outcome: "revise",
      findings: [
        { severity: "P0", title: "Valid", detail: "real finding" },
        { severity: "INVALID", title: "Bad severity" },
        { not_a_finding: true },
      ],
      summary: "Mixed findings",
    });
    await writeFakeBinary("claude", `echo '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.severity).toBe("P0");
  });

  it("uses structured Claude command and writes reviewer artifacts when enabled", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "claude-args.txt");
    await writeFakeBinary(
      "claude",
      `printf '%s\\n' "$@" > "${argsLog}"
cat > /dev/null
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"outcome":"pass","findings":[],"summary":"structured pass"}}
JSON
echo "structured stderr" >&2`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());
    const logDir = join(artifactDir, "run-1", "attempt-1");

    expect(result.outcome).toBe("pass");
    expect(result.summary).toBe("structured pass");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain('"outcome"');
    await expect(readFile(join(logDir, "reviewer-stdout.log"), "utf8")).resolves.toContain(
      "structured_output",
    );
    await expect(readFile(join(logDir, "reviewer-stderr.log"), "utf8")).resolves.toContain(
      "structured stderr",
    );
    await expect(readFile(join(logDir, "reviewer-structured.json"), "utf8")).resolves.toContain(
      "structured pass",
    );
    const metadata = JSON.parse(await readFile(join(logDir, "reviewer-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      outputMode: "json-schema",
      parse: { ok: true, source: "structured_output", outcome: "pass" },
    });
  });

  it("keeps Codex reviewer on the legacy agent command when structured Claude is enabled", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "codex-args.txt");
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "Codex OK" });
    await writeFakeBinary(
      "codex",
      `printf '%s\\n' "$@" > "${argsLog}" && cat > /dev/null && echo '${output}'`,
    );

    const context = createContext();
    context.project.reviewer = "codex";
    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(context);

    expect(result.outcome).toBe("pass");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("exec");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--json-schema");
  });

  it("falls back to free-form parsing when Claude wrapper JSON is invalid", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "fallback OK" });
    await writeFakeBinary("claude", `printf '%s\\n%s\\n' 'wrapper parse failed' '${output}'`);

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
    expect(result.summary).toBe("fallback OK");
  });

  it("falls back to wrapper result text when structured output is missing", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "claude",
      `cat > /dev/null
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"{\\"outcome\\":\\"pass\\",\\"findings\\":[],\\"summary\\":\\"result fallback\\"}"}
JSON`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
    expect(result.summary).toBe("result fallback");
  });

  it("maps an error wrapper without structured output to blocked", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "claude",
      `cat > /dev/null
cat <<'JSON'
{"type":"result","subtype":"error_max_turns","is_error":true,"result":"failed"}
JSON`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("unexpected shape");
  });

  it("maps a non-success wrapper subtype without structured output to blocked", async () => {
    process.env.LOOMFORGE_CLAUDE_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "claude",
      `cat > /dev/null
cat <<'JSON'
{"type":"result","subtype":"error_during_execution","is_error":false,"result":"failed"}
JSON`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("unexpected shape");
  });

  it("receives prompt on stdin with verification evidence", async () => {
    const stdinLog = join(tmpDir, "stdin-capture.txt");
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "OK" });
    await writeFakeBinary("claude", `cat > "${stdinLog}" && echo '${output}'`);

    const ctx = createContext();
    ctx.attempt.verificationResult = {
      outcome: "pass",
      summary: "All passed",
      rawLogPath: "",
      commandResults: [
        { name: "test", command: "pnpm test", outcome: "pass", rawLogPath: "" },
        { name: "lint", command: "pnpm lint", outcome: "pass", rawLogPath: "" },
      ],
    };

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    await runner.review(ctx);

    const captured = await readFile(stdinLog, "utf8");
    expect(captured).toContain("staff engineer");
    expect(captured).toContain("Integration");
    expect(captured).toContain("Completeness");
    expect(captured).toContain("Verification Results");
    expect(captured).toContain("test: pass");
    expect(captured).toContain("lint: pass");
  });
});

describe("ReviewerRunnerImpl structured Codex reviewer", () => {
  function createCodexContext(): WorkflowStepContext {
    const ctx = createContext();
    ctx.project.reviewer = "codex";
    return ctx;
  }

  it("keeps the legacy codex command when the env flag is disabled", async () => {
    const argsLog = join(tmpDir, "codex-args.txt");
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "Codex OK" });
    await writeFakeBinary(
      "codex",
      `printf '%s\\n' "$@" > "${argsLog}" && cat > /dev/null && echo '${output}'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createCodexContext());

    expect(result.outcome).toBe("pass");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("exec");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--output-last-message");
  });

  it("runs codex with --output-schema and --output-last-message and parses the final file", async () => {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "codex-args.txt");
    await writeFakeBinary(
      "codex",
      `printf '%s\\n' "$@" > "${argsLog}"
schema=""
final=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift
      schema="$1"
      ;;
    --output-last-message)
      shift
      final="$1"
      ;;
  esac
  shift
done
if [ ! -f "$schema" ]; then
  echo "schema missing" >&2
  exit 17
fi
cat > /dev/null
cat > "$final" <<'JSON'
{"outcome":"revise","findings":[{"severity":"P0","title":"Null check","detail":"Guard input"}],"summary":"needs guards"}
JSON
echo "codex stderr" >&2`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createCodexContext());
    const logDir = join(artifactDir, "run-1", "attempt-1");

    expect(result.outcome).toBe("revise");
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.title).toBe("Null check");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("exec");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    await expect(readFile(join(logDir, "reviewer-final.json"), "utf8")).resolves.toContain(
      "Null check",
    );
    await expect(readFile(join(logDir, "reviewer-output.schema.json"), "utf8")).resolves.toContain(
      '"outcome"',
    );
    await expect(readFile(join(logDir, "reviewer-stderr.log"), "utf8")).resolves.toContain(
      "codex stderr",
    );
  });

  it("tolerates fenced JSON in the final file", async () => {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "codex",
      `final=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift
      [ -f "$1" ] || exit 17
      ;;
    --output-last-message)
      shift
      final="$1"
      ;;
  esac
  shift
done
cat > /dev/null
cat > "$final" <<'TXT'
Here is the review:
\`\`\`json
{"outcome":"pass","findings":[],"summary":"all good"}
\`\`\`
TXT`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createCodexContext());

    expect(result.outcome).toBe("pass");
    expect(result.summary).toBe("all good");
  });

  it("falls back to stdout parsing when the final file is missing or invalid", async () => {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "codex",
      `final=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift
      [ -f "$1" ] || exit 17
      ;;
    --output-last-message)
      shift
      final="$1"
      ;;
  esac
  shift
done
cat > /dev/null
printf '%s' "not json from final" > "$final"
echo '{"outcome":"pass","findings":[],"summary":"from stdout"}'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createCodexContext());

    expect(result.outcome).toBe("pass");
    expect(result.summary).toBe("from stdout");
  });

  it("returns blocked when neither the final file nor stdout has valid JSON", async () => {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "codex",
      `final=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift
      [ -f "$1" ] || exit 17
      ;;
    --output-last-message)
      shift
      final="$1"
      ;;
  esac
  shift
done
cat > /dev/null
printf '%s' "still not json" > "$final"
echo "no json on stdout either"`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createCodexContext());

    expect(result.outcome).toBe("blocked");
  });

  it("uses the structured Codex command only when the resolved tool is codex", async () => {
    process.env.LOOMFORGE_CODEX_REVIEWER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "claude-args.txt");
    const output = JSON.stringify({ outcome: "pass", findings: [], summary: "Claude OK" });
    await writeFakeBinary(
      "claude",
      `printf '%s\\n' "$@" > "${argsLog}" && cat > /dev/null && echo '${output}'`,
    );

    const runner = new ReviewerRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.review(createContext());

    expect(result.outcome).toBe("pass");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("-p");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--output-last-message");
  });
});
