import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BuilderRunnerImpl } from "../../src/runners/codex-builder-runner.js";
import type { WorkflowStepContext, PushContext } from "../../src/workflow/types.js";
import { parseProjectConfigRegistry } from "../../src/config/index.js";

let tmpDir: string;
let repoDir: string;
let artifactDir: string;
let binDir: string;
let originalPath: string | undefined;
let originalBuilderOutput: string | undefined;
let originalClaudeBuilderOutput: string | undefined;

function createContext(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  const project =
    parseProjectConfigRegistry(
      `
projects:
  - slug: test
    repoRoot: ${repoDir}
    defaultBranch: main
    builder: codex
    timeouts:
      builderMs: 10000
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
      state: "building",
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

function createPushContext(overrides: Partial<PushContext> = {}): PushContext {
  const context = createContext();
  return {
    run: context.run,
    project: context.project,
    issue: context.issue,
    workspace: context.workspace,
    attempt: context.attempt,
    ...overrides,
  };
}

beforeEach(async () => {
  originalPath = process.env.PATH;
  originalBuilderOutput = process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT;
  originalClaudeBuilderOutput = process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT;
  tmpDir = await mkdtemp(join(tmpdir(), "loom-codex-"));
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
  delete process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT;
  delete process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalBuilderOutput === undefined) {
    delete process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT;
  } else {
    process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT = originalBuilderOutput;
  }
  if (originalClaudeBuilderOutput === undefined) {
    delete process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT;
  } else {
    process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT = originalClaudeBuilderOutput;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("BuilderRunnerImpl", () => {
  it("returns success when codex creates a commit", async () => {
    await writeFakeBinary(
      "codex",
      `cd "${repoDir}" && echo "change" > file.txt && git add file.txt && git commit -m "feat: change" && echo "CHANGED_FILES:" && echo "- file.txt" && echo "SUMMARY:" && echo "added file" && echo "VERIFICATION:" && echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("success");
    expect(result.commitSha).toBeTruthy();
    expect(result.changedFiles).toContain("file.txt");
  });

  it("returns failed when codex exits non-zero", async () => {
    await writeFakeBinary("codex", "echo 'error' >&2; exit 1");

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.commitSha).toBeNull();
  });

  it("returns blocked with runner_auth_missing when codex exits with auth error", async () => {
    await writeFakeBinary("codex", "echo 'Unauthorized: token expired' >&2; exit 1");

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("runner_auth_missing");
    expect(result.summary).toContain("authentication failed");
    expect(result.commitSha).toBeNull();
  });

  it("returns failed with timeout when codex exceeds time limit", async () => {
    await writeFakeBinary("codex", "exec sleep 60");

    const project = createContext().project;
    project.timeouts.builderMs = 500;
    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext({ project }));

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("timeout");
  }, 15_000);

  it("returns failed when codex succeeds but no commit is created", async () => {
    await writeFakeBinary(
      "codex",
      `echo "CHANGED_FILES:" && echo "- nothing.txt" && echo "SUMMARY:" && echo "done" && echo "VERIFICATION:" && echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.summary).toContain("claimed changes but produced no diff");
  });

  it("returns no_changes when codex reports FAILED_NO_CHANGES with a clean tree", async () => {
    await writeFakeBinary(
      "codex",
      `echo "FAILED_NO_CHANGES: dev already has the work; nothing to do"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("no_changes");
    expect(result.commitSha).toBeNull();
    expect(result.summary).toContain("dev already has the work");
  });

  it("returns failed after two consecutive no-ops", async () => {
    await writeFakeBinary("codex", "echo 'just commentary, no contract output'");

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.summary).toContain("no structured output");
  });

  it("receives prompt on stdin", async () => {
    const stdinLog = join(tmpDir, "stdin-capture.txt");
    await writeFakeBinary(
      "codex",
      `cat > "${stdinLog}" && cd "${repoDir}" && echo "change" > file.txt && git add file.txt && git commit -m "feat: stdin" && echo "CHANGED_FILES:" && echo "- file.txt" && echo "SUMMARY:" && echo "done" && echo "VERIFICATION:" && echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    await runner.build(createContext());

    const { readFile } = await import("node:fs/promises");
    const captured = await readFile(stdinLog, "utf8");
    expect(captured).toContain("Codex builder for TEZ-1");
    expect(captured).toContain("## Gate");
  });

  it("keeps the legacy codex command when structured output is disabled", async () => {
    const argsLog = join(tmpDir, "codex-args.txt");
    await writeFakeBinary(
      "codex",
      `printf '%s\\n' "$@" > "${argsLog}" && cd "${repoDir}" && echo "change" > file.txt && git add file.txt && git commit -m "feat: legacy" >/dev/null && echo "CHANGED_FILES:" && echo "- file.txt" && echo "SUMMARY:" && echo "done" && echo "VERIFICATION:" && echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("success");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("exec");
    expect(args).not.toContain("--json");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--output-last-message");
  });

  it("runs codex with schema flags and writes structured artifacts when enabled", async () => {
    process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT = "json-schema";
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
cd "${repoDir}" && echo "actual" > actual.txt && git add actual.txt && git commit -m "feat: structured" >/dev/null
cat > "$final" <<'JSON'
{"outcome":"success","changed_files":["reported-only.txt"],"summary":"structured","verification":[{"command":"pnpm test","outcome":"pass","summary":"ok"}],"blocker":""}
JSON
echo '{"type":"thread.started","thread_id":"t"}'
echo '{"type":"turn.started"}'
echo "structured stderr" >&2`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());
    const logDir = join(artifactDir, "run-1", "attempt-1");

    expect(result.outcome).toBe("success");
    expect(result.changedFiles).toEqual(["actual.txt"]);
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("--json");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    await expect(readFile(join(logDir, "builder-events.jsonl"), "utf8")).resolves.toContain(
      "thread.started",
    );
    await expect(readFile(join(logDir, "builder-stderr.log"), "utf8")).resolves.toContain(
      "structured stderr",
    );
    await expect(readFile(join(logDir, "builder-final.txt"), "utf8")).resolves.toContain(
      "reported-only.txt",
    );
    await expect(readFile(join(logDir, "builder-output.schema.json"), "utf8")).resolves.toContain(
      '"blocker"',
    );
    const summary = JSON.parse(await readFile(join(logDir, "builder-summary.json"), "utf8"));
    expect(summary).toMatchObject({
      outputMode: "json-schema",
      parse: {
        ok: true,
        source: "final",
        outcome: "success",
      },
    });
    expect(summary.schema.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back to the captured final assistant event when builder-final is missing", async () => {
    process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "codex",
      `while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift
      [ -f "$1" ] || exit 17
      ;;
  esac
  shift
done
cat > /dev/null
cd "${repoDir}" && echo "event" > event.txt && git add event.txt && git commit -m "feat: event" >/dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"success\\",\\"changed_files\\":[\\"event.txt\\"],\\"summary\\":\\"from event\\",\\"verification\\":[{\\"command\\":\\"pnpm test\\",\\"outcome\\":\\"pass\\",\\"summary\\":\\"ok\\"}],\\"blocker\\":\\"\\"}"}}'`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());
    const summaryPath = join(artifactDir, "run-1", "attempt-1", "builder-summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));

    expect(result.outcome).toBe("success");
    expect(summary.parse.source).toBe("events");
  });

  it("uses builder-final text, not JSONL events, in the corrective retry prompt", async () => {
    process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT = "json-schema";
    const countFile = join(tmpDir, "codex-count.txt");
    const retryPromptLog = join(tmpDir, "retry-prompt.txt");
    await writeFakeBinary(
      "codex",
      `count=0
if [ -f "${countFile}" ]; then
  count=$(cat "${countFile}")
fi
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
final=""
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
prompt=$(cat)
if [ "$count" = "1" ]; then
  printf '%s' "not json from builder-final" > "$final"
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"EVENT_JSONL_NOISE"}}'
  exit 0
fi
printf '%s' "$prompt" > "${retryPromptLog}"
cd "${repoDir}" && echo "retry" > retry.txt && git add retry.txt && git commit -m "feat: retry" >/dev/null
cat > "$final" <<'JSON'
{"outcome":"success","changed_files":["retry.txt"],"summary":"retry ok","verification":[{"command":"pnpm test","outcome":"pass","summary":"ok"}],"blocker":""}
JSON
echo '{"type":"thread.started","thread_id":"retry"}'`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());
    const retryPrompt = await readFile(retryPromptLog, "utf8");

    expect(result.outcome).toBe("success");
    expect(retryPrompt).toContain("not json from builder-final");
    expect(retryPrompt).not.toContain("EVENT_JSONL_NOISE");
  });

  it("returns runner_error after invalid structured output on retry", async () => {
    process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT = "json-schema";
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
echo '{"type":"turn.completed"}'`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.summary).toContain("invalid structured output");
  });
});

describe("BuilderRunnerImpl push", () => {
  it("directly pushes the configured dev branch", async () => {
    const argsLog = join(tmpDir, "git-push-args.txt");
    await writeFakeBinary(
      "git",
      `if [ "$1" = "push" ]; then
  printf '%s\\n' "$@" > "${argsLog}"
  echo "pushed"
  exit 0
fi
if [ "$1" = "rev-list" ]; then
  echo "0 0"
  exit 0
fi
echo "unexpected git command: $*" >&2
exit 2`,
    );

    const base = createContext();
    const project = { ...base.project, devBranch: "integration" };
    const workspace = { ...base.workspace, branchName: project.devBranch };
    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const pushCtx = createPushContext({ project, workspace });
    const result = await runner.push(pushCtx);

    expect(result.outcome).toBe("success");
    expect(await readFile(argsLog, "utf8")).toBe("push\norigin\nintegration\n");
  });

  it("returns failed when push exits non-zero", async () => {
    await writeFakeBinary(
      "git",
      `if [ "$1" = "push" ]; then
  echo "push error" >&2
  exit 1
fi
exit 2`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.push(createPushContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("push_failed");
  });

  it("returns blocked with runner_auth_missing when push exits with auth error", async () => {
    await writeFakeBinary(
      "git",
      `if [ "$1" = "push" ]; then
  echo "Authentication failed: not logged in" >&2
  exit 1
fi
exit 2`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.push(createPushContext());

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("runner_auth_missing");
    expect(result.summary).toContain("authentication failed");
  });

  it.each(["main", "master", "release"])("refuses protected branch %s", async (branchName) => {
    const context = createContext();
    const project = { ...context.project, defaultBranch: "release" };
    const workspace = { ...context.workspace, branchName };
    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.push(createPushContext({ project, workspace }));

    expect(result.outcome).toBe("blocked");
    expect(result.failureReason).toBe("push_failed");
    expect(result.summary).toContain("Refusing to push");
  });

  it("fails when remote sync verification reports divergence", async () => {
    await writeFakeBinary(
      "git",
      `if [ "$1" = "push" ]; then
  echo "pushed"
  exit 0
fi
if [ "$1" = "rev-list" ]; then
  echo "1 0"
  exit 0
fi
exit 2`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.push(createPushContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("push_failed");
    expect(result.summary).toContain("ahead");
  });
});

describe("BuilderRunnerImpl structured Claude builder", () => {
  function createClaudeContext(): WorkflowStepContext {
    const ctx = createContext();
    ctx.project.builder = "claude";
    return ctx;
  }

  it("keeps the legacy claude command when the env flag is disabled", async () => {
    const argsLog = join(tmpDir, "claude-args.txt");
    await writeFakeBinary(
      "claude",
      `printf '%s\\n' "$@" > "${argsLog}"
cat > /dev/null
cd "${repoDir}" && echo "legacy" > legacy.txt && git add legacy.txt && git commit -m "feat: legacy" >/dev/null
echo "CHANGED_FILES:"
echo "- legacy.txt"
echo "SUMMARY:"
echo "done"
echo "VERIFICATION:"
echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.build(createClaudeContext());

    expect(result.outcome).toBe("success");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("-p");
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--output-format");
  });

  it("runs claude with --json-schema and writes structured artifacts when enabled", async () => {
    process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "claude-args.txt");
    await writeFakeBinary(
      "claude",
      `printf '%s\\n' "$@" > "${argsLog}"
cat > /dev/null
cd "${repoDir}" && echo "actual" > actual.txt && git add actual.txt && git commit -m "feat: structured" >/dev/null
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"outcome":"success","changed_files":["reported-only.txt"],"summary":"structured ok","verification":[{"command":"pnpm test","outcome":"pass","summary":"ok"}],"blocker":""}}
JSON
echo "structured stderr" >&2`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.build(createClaudeContext());
    const logDir = join(artifactDir, "run-1", "attempt-1");

    expect(result.outcome).toBe("success");
    expect(result.changedFiles).toEqual(["actual.txt"]);
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain('"changed_files"');
    await expect(readFile(join(logDir, "builder-stdout.log"), "utf8")).resolves.toContain(
      "structured_output",
    );
    await expect(readFile(join(logDir, "builder-stderr.log"), "utf8")).resolves.toContain(
      "structured stderr",
    );
    await expect(readFile(join(logDir, "builder-structured.json"), "utf8")).resolves.toContain(
      "reported-only.txt",
    );
    const metadata = JSON.parse(await readFile(join(logDir, "builder-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      outputMode: "json-schema",
      parse: { ok: true, source: "structured_output", outcome: "success" },
    });
  });

  it("falls back to the text contract when the wrapper JSON cannot be parsed", async () => {
    process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "claude",
      `cat > /dev/null
cd "${repoDir}" && echo "fallback" > fallback.txt && git add fallback.txt && git commit -m "feat: fallback" >/dev/null
echo "wrapper parse failed"
echo "CHANGED_FILES:"
echo "- fallback.txt"
echo "SUMMARY:"
echo "fallback summary"
echo "VERIFICATION:"
echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.build(createClaudeContext());

    expect(result.outcome).toBe("success");
    expect(result.changedFiles).toEqual(["fallback.txt"]);
  });

  it("triggers retry when wrapper has is_error and no structured payload, then runner_error", async () => {
    process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT = "json-schema";
    await writeFakeBinary(
      "claude",
      `cat > /dev/null
cat <<'JSON'
{"type":"result","subtype":"error_max_turns","is_error":true,"result":"max turns reached"}
JSON`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "claude" });
    const result = await runner.build(createClaudeContext());

    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toBe("runner_error");
    expect(result.summary).toContain("invalid structured output");
  });

  it("uses the structured Claude command only when the resolved tool is claude", async () => {
    process.env.LOOMFORGE_CLAUDE_BUILDER_OUTPUT = "json-schema";
    const argsLog = join(tmpDir, "codex-args.txt");
    await writeFakeBinary(
      "codex",
      `printf '%s\\n' "$@" > "${argsLog}" && cat > /dev/null && cd "${repoDir}" && echo "codex" > codex.txt && git add codex.txt && git commit -m "feat: codex" >/dev/null && echo "CHANGED_FILES:" && echo "- codex.txt" && echo "SUMMARY:" && echo "done" && echo "VERIFICATION:" && echo "- echo ok: pass"`,
    );

    const runner = new BuilderRunnerImpl({ artifactDir, tool: "codex" });
    const result = await runner.build(createContext());

    expect(result.outcome).toBe("success");
    const args = await readFile(argsLog, "utf8");
    expect(args).toContain("exec");
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--output-format");
  });
});
