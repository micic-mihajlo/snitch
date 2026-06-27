import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyDemoRepair } from "../../../scripts/apply-demo-repair";
import {
  handleMcpJsonRpcMessage,
  ingestHookEvent,
  readLiveState,
  refreshWatchedTarget,
  runCli
} from "./cli";

const tempDirs: string[] = [];
const now = new Date("2026-06-27T12:00:00.000Z");
const demoRoot = resolve(import.meta.dirname, "../../../apps/demo-app");
const execFile = promisify(execFileCallback);
const gitLocalEnvNames = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE"
];

describe("snitch cli", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("initializes a background companion workspace", async () => {
    const cwd = await tempRepo();
    const result = await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch background companion initialized");
    await expect(readFile(join(cwd, ".snitch/config.json"), "utf8")).resolves.toContain(
      "background-companion"
    );
    await expect(readFile(join(cwd, ".snitch/session.json"), "utf8")).resolves.toContain(
      "\"status\": \"initialized\""
    );
    await expect(readFile(join(cwd, ".snitch/handoff.md"), "utf8")).resolves.toContain(
      "Wire an issue tool"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.md"), "utf8")).resolves.toContain(
      "Snitch briefing"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.json"), "utf8")).resolves.toContain(
      "\"task\": \"Wire an issue tool\""
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "pnpm"
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "SNITCH_INGEST_URL"
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "postToLiveServer"
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "isLoopbackTarget"
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "findRepoRoot"
    );
    await expect(readFile(join(cwd, ".snitch/hooks/codex-hook.mjs"), "utf8")).resolves.toContain(
      "agentFeedback"
    );

    const hookStats = await stat(join(cwd, ".snitch/hooks/codex-hook.mjs"));
    expect(hookStats.mode & 0o111).toBeGreaterThan(0);
  });

  it("can generate Codex, Cursor, Claude, and OpenCode background adapter configs", async () => {
    const cwd = await tempRepo();
    const result = await runCli(
      ["init", "--agent", "all", "--target", demoRoot, "--task", "Wire an issue tool"],
      {
        cwd,
        now
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(".codex/hooks.json");
    expect(result.stdout).toContain(".cursor/rules/snitch.mdc");
    expect(result.stdout).toContain(".claude/settings.local.json");
    expect(result.stdout).toContain(".opencode/plugins/snitch.ts");
    expect(result.stdout).toContain(`Analysis target: ${demoRoot}`);
    await expect(readFile(join(cwd, ".codex/hooks.json"), "utf8")).resolves.toContain(
      "PostToolUse"
    );
    await expect(readFile(join(cwd, ".codex/hooks.json"), "utf8")).resolves.toContain(
      "git rev-parse --show-toplevel"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "Snitch local verification"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch check"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch briefing"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch repair-prompt"
    );
    await expect(readFile(join(cwd, ".claude/settings.local.json"), "utf8")).resolves.toContain(
      "SNITCH_SOURCE=claude"
    );
    await expect(readFile(join(cwd, ".opencode/plugins/snitch.ts"), "utf8")).resolves.toContain(
      "tool.execute.after"
    );
    await expect(readFile(join(cwd, ".opencode/plugins/snitch.ts"), "utf8")).resolves.toContain(
      "event.type"
    );
  });

  it("installs managed local Git hooks for durable Snitch snapshots", async () => {
    const cwd = await tempRepo();
    await mkdir(join(cwd, ".git/hooks"), { recursive: true });

    const result = await runCli(["install-git-hooks"], { cwd, now });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch Git hooks installed");
    expect(result.stdout).toContain(".git/hooks/post-commit");
    expect(result.stdout).toContain(".git/hooks/pre-push");
    const postCommit = await readFile(join(cwd, ".git/hooks/post-commit"), "utf8");
    const prePush = await readFile(join(cwd, ".git/hooks/pre-push"), "utf8");
    const postCommitStats = await stat(join(cwd, ".git/hooks/post-commit"));
    const prePushStats = await stat(join(cwd, ".git/hooks/pre-push"));

    expect(postCommit).toContain("# snitch-managed:post-commit");
    expect(prePush).toContain("# snitch-managed:pre-push");
    expect(prePush).toContain("--source git");
    expect(prePush).toContain("file_changed:pre-push");
    expect(prePush).not.toContain("publish-github");
    expect(prePush).not.toContain("GITHUB_TOKEN");
    expect(postCommitStats.mode & 0o111).toBeGreaterThan(0);
    expect(prePushStats.mode & 0o111).toBeGreaterThan(0);
  });

  it("refuses to overwrite unmanaged local Git hooks by default", async () => {
    const cwd = await tempRepo();
    await mkdir(join(cwd, ".git/hooks"), { recursive: true });
    await writeFile(join(cwd, ".git/hooks/pre-push"), "# existing team hook\n", "utf8");

    const result = await runCli(["install-git-hooks"], { cwd, now });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to overwrite existing Git hook");
    await expect(readFile(join(cwd, ".git/hooks/pre-push"), "utf8")).resolves.toBe(
      "# existing team hook\n"
    );
    await expect(readFile(join(cwd, ".git/hooks/post-commit"), "utf8")).rejects.toThrow();
  });

  it("records hook events without storing the raw payload", async () => {
    const cwd = await tempRepo();
    const payload = JSON.stringify({
      tool_name: "apply_patch",
      file_path: "src/tools/issues.ts",
      command: "run-with-private-value do-not-store-this",
      unsafe_value: "do-not-store-this"
    });

    await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });
    const result = await runCli(["event", "--source", "codex", "--hook", "PostToolUse"], {
      cwd,
      stdin: payload,
      now: new Date("2026-06-27T12:01:00.000Z")
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch captured codex:PostToolUse");
    expect(result.stdout).toContain("Next action:");
    const events = await readFile(join(cwd, ".snitch/events.jsonl"), "utf8");
    expect(events).toContain("apply_patch");
    expect(events).toContain("src/tools/issues.ts");
    expect(events).not.toContain("do-not-store-this");
    expect(events).not.toContain("run-with-private-value");
    expect(events).toContain("commandHash");
    await expect(readFile(join(cwd, ".snitch/graph.json"), "utf8")).resolves.toContain(
      "Create issue tool"
    );
    await expect(readFile(join(cwd, ".snitch/next-action.md"), "utf8")).resolves.toContain(
      "Snitch Next Action"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.md"), "utf8")).resolves.toContain(
      "Snitch briefing"
    );
  });

  it("refreshes the graph from the TypeScript target after a file-changing hook", async () => {
    const cwd = await tempRepo();
    const payload = JSON.stringify({
      tool_name: "apply_patch",
      file_path: "src/tools/create-issue.ts"
    });

    await runCli(["init", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });
    const result = await runCli(["event", "--source", "codex", "--hook", "PostToolUse"], {
      cwd,
      stdin: payload,
      now: new Date("2026-06-27T12:01:00.000Z")
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Graph: refreshed from TypeScript target");
    await expect(readFile(join(cwd, ".snitch/graph.json"), "utf8")).resolves.toContain(
      "api.github.com API"
    );
    await expect(readFile(join(cwd, ".snitch/session.json"), "utf8")).resolves.toContain(
      "\"graphSource\": \"typescript\""
    );
    await expect(readFile(join(cwd, ".snitch/pr-comment.md"), "utf8")).resolves.toContain(
      "No audit trail for external tool calls"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.json"), "utf8")).resolves.toContain(
      "warning:tool_audit_log_missing:create_issue"
    );

    const promptResult = await runCli(["event", "--source", "codex", "--hook", "UserPromptSubmit"], {
      cwd,
      stdin: JSON.stringify({ prompt: "keep going" }),
      now: new Date("2026-06-27T12:02:00.000Z")
    });

    expect(promptResult.code).toBe(0);
    expect(promptResult.stdout).toContain("Graph: kept current TypeScript graph");
    await expect(readFile(join(cwd, ".snitch/graph.json"), "utf8")).resolves.toContain(
      "api.github.com API"
    );
  });

  it("ingests live hook events through the watcher HTTP path", async () => {
    const cwd = await tempRepo();
    const payload = JSON.stringify({
      tool_name: "apply_patch",
      file_path: "src/tools/create-issue.ts",
      command: "apply private-token-value"
    });

    await runCli(["init", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });
    const result = await ingestHookEvent(cwd, {
      source: "claude",
      hook: "PostToolUse",
      body: payload,
      now: new Date("2026-06-27T12:02:30.000Z")
    });
    const events = await readFile(join(cwd, ".snitch/events.jsonl"), "utf8");
    const state = await readLiveState(cwd);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Snitch captured claude:PostToolUse");
    expect(result.agentFeedback).toContain("Snitch Next Action");
    expect(result.nextAction.status).toBe("action_required");
    expect(result.nextAction.relatedEvents[0]).toMatchObject({
      source: "claude",
      hook: "PostToolUse"
    });
    expect(events).toContain("apply_patch");
    expect(events).toContain("src/tools/create-issue.ts");
    expect(events).toContain("commandHash");
    expect(events).not.toContain("private-token-value");
    expect(state.session).toMatchObject({
      graphSource: "typescript",
      eventCount: 1
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      source: "claude",
      phase: "tool_after",
      hook: "PostToolUse",
      safeSummary: {
        tool_name: "apply_patch",
        file_path: "src/tools/create-issue.ts"
      }
    });
    expect(JSON.stringify(state.events)).toContain("commandHash");
    expect(JSON.stringify(state.events)).not.toContain("private-token-value");
    expect(state.graph.nodes.some((node) => node.label === "api.github.com API")).toBe(true);
  });

  it("prints status for the agent background loop", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });
    const result = await runCli(["status"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch background companion");
    expect(result.stdout).toContain("Status:");
    expect(result.stdout).toContain("Graph:");
    expect(result.stdout).toContain("Warnings:");
    expect(result.stdout).toContain("Analysis target: .");
  });

  it("prints JSON status for coding-agent automation", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });
    await ingestHookEvent(cwd, {
      source: "codex",
      hook: "PostToolUse",
      body: JSON.stringify({
        tool_name: "shell",
        file_path: "src/tools/create-issue.ts",
        command: "pnpm deploy --token private-status-secret"
      }),
      now: new Date("2026-06-27T12:01:00.000Z")
    });

    const result = await runCli(["status", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.session.graphSource).toBe("typescript");
    expect(parsed.session.analysisTarget).toBe(demoRoot);
    expect(parsed.counts.events).toBe(1);
    expect(parsed.counts.nodes).toBeGreaterThan(0);
    expect(parsed.counts.warnings).toBeGreaterThan(0);
    expect(parsed.warnings[0].repairCommand).toContain("pnpm snitch repair-prompt --warning");
    expect(parsed.recentEvents[0].safeSummary.commandHash).toBeTruthy();
    expect(parsed.artifacts.nextAction.available).toBe(true);
    expect(parsed.artifacts.prComment.available).toBe(true);
    expect(parsed.nextCommands).toContain("pnpm snitch changed --json");
    expect(parsed.nextCommands).toContain("pnpm snitch next-action --json");
    expect(
      parsed.nextCommands.some((command: string) => command.startsWith("pnpm snitch trace --warning "))
    ).toBe(true);
    expect(
      parsed.nextCommands.some((command: string) => command.startsWith("pnpm snitch verify-repair --warning "))
    ).toBe(true);
    expect(parsed.nextCommands).toContain(
      `pnpm snitch check --target '${demoRoot}' --fail-on medium --json`
    );
    expect(JSON.stringify(parsed)).toContain("commandHash");
    expect(JSON.stringify(parsed)).not.toContain("private-status-secret");
  });

  it("reports Snitch setup readiness for coding agents", async () => {
    const cwd = await tempRepo();

    await mkdir(join(cwd, ".git/hooks"), { recursive: true });
    await runCli(["init", "--agent", "all", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });

    const initial = await runCli(["doctor", "--json"], { cwd });
    const initialPayload = JSON.parse(initial.stdout);
    const initialHookCheck = initialPayload.checks.find(
      (check: { id: string }) => check.id === "git-hooks"
    );

    expect(initial.code).toBe(0);
    expect(initialPayload.ready).toBe(true);
    expect(initialPayload.summary.fail).toBe(0);
    expect(initialPayload.config.generatedConfigs).toEqual([
      ".codex/hooks.json",
      ".cursor/rules/snitch.mdc",
      ".claude/settings.local.json",
      ".opencode/plugins/snitch.ts"
    ]);
    expect(initialPayload.checks).toContainEqual(
      expect.objectContaining({
        id: "hook-adapter",
        status: "pass",
        path: ".snitch/hooks/codex-hook.mjs"
      })
    );
    expect(initialPayload.checks).toContainEqual(
      expect.objectContaining({
        id: "agent-configs",
        status: "pass"
      })
    );
    expect(initialPayload.checks).toContainEqual(
      expect.objectContaining({
        id: "providers",
        status: "pass"
      })
    );
    expect(initialHookCheck).toMatchObject({
      status: "warn",
      nextCommand: "pnpm snitch install-git-hooks"
    });
    expect(JSON.stringify(initialPayload)).not.toContain("CEREBRAS_API_KEY");
    expect(initialPayload.nextCommands).toContain("pnpm snitch status --json");
    expect(initialPayload.nextCommands).toContain("pnpm snitch changed --json");

    await runCli(["install-git-hooks"], { cwd, now });

    const afterHooks = await runCli(["doctor"], { cwd });

    expect(afterHooks.code).toBe(0);
    expect(afterHooks.stdout).toContain("Snitch doctor");
    expect(afterHooks.stdout).toContain("Ready: yes");
    expect(afterHooks.stdout).toContain("[pass] Local Git hooks");
  });

  it("fails doctor readiness when configured agent wiring is missing", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--agent", "codex", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    await rm(join(cwd, ".codex/hooks.json"), { force: true });

    const result = await runCli(["doctor", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    const mcp = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: {
        name: "snitch_doctor",
        arguments: {}
      }
    });
    const mcpResult = mcp as {
      result: {
        structuredContent: {
          ready: boolean;
          checks: Array<{ id: string; status: string }>;
        };
      };
    };

    expect(result.code).toBe(0);
    expect(parsed.ready).toBe(false);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        id: "agent-configs",
        status: "fail"
      })
    );
    expect(mcpResult.result.structuredContent.ready).toBe(false);
    expect(mcpResult.result.structuredContent.checks).toContainEqual(
      expect.objectContaining({
        id: "agent-configs",
        status: "fail"
      })
    );
  });

  it("quotes shell-sensitive targets in agent-facing next commands", async () => {
    const cwd = await tempRepo();
    const target = "target;touch_should_not_run";

    await mkdir(join(cwd, target), { recursive: true });
    await runCli(["init", "--target", target, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(["doctor", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    const joinedCommands = parsed.nextCommands.join("\n");

    expect(joinedCommands).toContain("--target 'target;touch_should_not_run'");
    expect(joinedCommands).not.toContain("--target target;touch_should_not_run");
  });

  it("does not tell agents to force-overwrite unmanaged Git hooks", async () => {
    const cwd = await tempRepo();

    await mkdir(join(cwd, ".git/hooks"), { recursive: true });
    await writeFile(join(cwd, ".git/hooks/pre-push"), "# existing team hook\n", "utf8");
    await runCli(["init", "--agent", "codex", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });

    const result = await runCli(["doctor", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    const hookCheck = parsed.checks.find((check: { id: string }) => check.id === "git-hooks");

    expect(hookCheck).toMatchObject({
      status: "warn",
      nextCommand: "pnpm snitch install-git-hooks"
    });
    expect(JSON.stringify(parsed)).not.toContain("--force");
  });

  it("verifies task intent coverage from the current graph", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Add an external issue creation tool"], {
      cwd,
      now
    });

    const result = await runCli(
      ["verify-intent", "--task", "Add an external issue creation tool", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.status).toBe("partial");
    expect(parsed.capabilities).toContainEqual(
      expect.objectContaining({
        id: "issue_creation"
      })
    );
    expect(parsed.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:tool",
        status: "met",
        matchedNodeIds: ["tool:create_issue"]
      })
    );
    expect(parsed.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:audit",
        status: "missing"
      })
    );
    expect(parsed.relatedWarnings[0]).toMatchObject({
      id: "warning:tool_audit_log_missing:create_issue"
    });
    expect(parsed.nextCommands).toContain(
      "pnpm snitch repair-prompt --warning warning:tool_audit_log_missing:create_issue"
    );
    await expect(readFile(join(cwd, ".snitch/intent.json"), "utf8")).resolves.toContain(
      "\"status\": \"partial\""
    );

    const human = await runCli(["verify-intent", "--task", "Add an external issue creation tool"], {
      cwd
    });

    expect(human.stdout).toContain("Snitch intent coverage");
    expect(human.stdout).toContain("Issue tool exists");
    expect(human.stdout).toContain("External call has audit logging");
  });

  it("prints a scoped warning impact for coding-agent follow-up", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(
      [
        "impact",
        "--warning",
        "warning:secret_redaction_missing:create_issue",
        "--json"
      ],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.warning.id).toBe("warning:secret_redaction_missing:create_issue");
    expect(parsed.files).toContain("src/tools/create-issue.ts");
    expect(parsed.nodes.map((node: { id: string }) => node.id)).toContain("tool:create_issue");
    expect(parsed.nodes.map((node: { id: string }) => node.id)).not.toContain(
      "warning:unauthorized_test_missing:create_issue"
    );
    expect(parsed.nextCommands[0]).toBe(
      "pnpm snitch repair-prompt --warning warning:secret_redaction_missing:create_issue"
    );
    expect(parsed.nextCommands).toContain(
      `pnpm snitch verify-repair --warning warning:secret_redaction_missing:create_issue --target '${demoRoot}' --task 'Wire an issue tool' --json`
    );

    const human = await runCli(
      ["impact", "--warning", "warning:secret_redaction_missing:create_issue"],
      { cwd }
    );

    expect(human.stdout).toContain("Snitch impact");
    expect(human.stdout).toContain("Affected files:");
    expect(human.stdout).toContain("src/tools/create-issue.ts");
  });

  it("prints anchored review findings for active warnings", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(["findings", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.findings[0]).toMatchObject({
      warningId: "warning:tool_audit_log_missing:create_issue",
      anchor: {
        file: "src/tools/create-issue.ts",
        line: 9
      }
    });
    expect(parsed.findings[0].repairCommand).toContain("pnpm snitch repair-prompt --warning");

    const human = await runCli(["findings"], { cwd });

    expect(human.stdout).toContain("Snitch findings");
    expect(human.stdout).toContain("src/tools/create-issue.ts:9");
    expect(human.stdout).toContain("warning:tool_audit_log_missing:create_issue");
  });

  it("prints the next grounded agent action with related hook evidence", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });
    await runCli(["event", "--source", "codex", "--hook", "PostToolUse"], {
      cwd,
      stdin: JSON.stringify({
        tool_name: "apply_patch",
        file_path: "src/tools/create-issue.ts"
      }),
      now: new Date("2026-06-27T12:03:00.000Z")
    });

    const result = await runCli(["next-action", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.status).toBe("action_required");
    expect(parsed.topFinding).toMatchObject({
      warningId: "warning:tool_audit_log_missing:create_issue",
      anchor: {
        file: "src/tools/create-issue.ts",
        line: 9
      }
    });
    expect(parsed.relatedEvents[0]).toMatchObject({
      source: "codex",
      hook: "PostToolUse",
      safeSummary: {
        tool_name: "apply_patch",
        file_path: "src/tools/create-issue.ts"
      }
    });
    expect(parsed.agentInstruction).toContain("Address warning:tool_audit_log_missing:create_issue");

    const human = await runCli(["next-action"], { cwd });

    expect(human.stdout).toContain("Snitch Next Action");
    expect(human.stdout).toContain("Likely related agent events");
    expect(human.stdout).toContain("src/tools/create-issue.ts:9");
    expect(human.stdout).toContain("pnpm snitch repair-prompt --warning");
  });

  it("prints a compact agent briefing from current Snitch evidence", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(
      ["briefing", "--task", "Add an external issue creation tool", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.status).toBe("action_required");
    expect(parsed.counts).toMatchObject({
      warnings: 4,
      changedFiles: 0,
      changedFindings: 0
    });
    expect(parsed.intent.status).toBe("partial");
    expect(parsed.intent.missingRequirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:audit",
        status: "missing"
      })
    );
    expect(parsed.action.topFinding).toMatchObject({
      warningId: "warning:tool_audit_log_missing:create_issue",
      anchor: {
        file: "src/tools/create-issue.ts",
        line: 9
      }
    });
    expect(parsed.impact.warning.id).toBe("warning:tool_audit_log_missing:create_issue");
    expect(parsed.impact.files).toContain("src/tools/create-issue.ts");
    expect(parsed.nextCommands).toContain(
      `pnpm snitch verify-repair --warning warning:tool_audit_log_missing:create_issue --target '${demoRoot}' --task 'Add an external issue creation tool' --json`
    );

    const pinned = await runCli(
      [
        "briefing",
        "--task",
        "Add an external issue creation tool",
        "--warning",
        "warning:secret_redaction_missing:create_issue",
        "--json"
      ],
      { cwd }
    );
    const pinnedParsed = JSON.parse(pinned.stdout);

    expect(pinnedParsed.impact.warning.id).toBe("warning:secret_redaction_missing:create_issue");
    expect(pinnedParsed.nextCommands).toContain(
      `pnpm snitch verify-repair --warning warning:secret_redaction_missing:create_issue --target '${demoRoot}' --task 'Add an external issue creation tool' --json`
    );

    const human = await runCli(["briefing", "--task", "Add an external issue creation tool"], {
      cwd
    });

    expect(human.stdout).toContain("Snitch briefing");
    expect(human.stdout).toContain("Top action:");
    expect(human.stdout).toContain("Impact:");
    expect(human.stdout).toContain("Missing intent requirements:");
  });

  it("traces an active warning to graph evidence, safe events, and timeline entries", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });
    await runCli(["event", "--source", "codex", "--hook", "PostToolUse"], {
      cwd,
      stdin: JSON.stringify({
        tool_name: "apply_patch",
        file_path: "src/tools/create-issue.ts",
        command: "apply trace fixture payload"
      }),
      now: new Date("2026-06-27T12:03:30.000Z")
    });

    const result = await runCli(
      ["trace", "--warning", "warning:tool_audit_log_missing:create_issue", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.status).toBe("traced");
    expect(parsed.warning.id).toBe("warning:tool_audit_log_missing:create_issue");
    expect(parsed.finding.anchor).toMatchObject({
      file: "src/tools/create-issue.ts",
      line: 9
    });
    expect(parsed.relatedEvents[0]).toMatchObject({
      source: "codex",
      hook: "PostToolUse",
      safeSummary: {
        tool_name: "apply_patch",
        file_path: "src/tools/create-issue.ts"
      }
    });
    expect(JSON.stringify(parsed)).toContain("commandHash");
    expect(JSON.stringify(parsed)).not.toContain("trace fixture payload");
    expect(parsed.timeline.length).toBeGreaterThan(0);
    expect(parsed.impact.files).toContain("src/tools/create-issue.ts");
    expect(parsed.nextCommands[0]).toBe(
      "pnpm snitch repair-prompt --warning warning:tool_audit_log_missing:create_issue"
    );
    expect(parsed.nextCommands).toContain(
      `pnpm snitch verify-repair --warning warning:tool_audit_log_missing:create_issue --target '${demoRoot}' --task 'Wire an issue tool' --json`
    );

    const human = await runCli(
      ["trace", "--warning", "warning:tool_audit_log_missing:create_issue"],
      { cwd }
    );

    expect(human.stdout).toContain("Snitch warning trace");
    expect(human.stdout).toContain("Likely related agent events");
    expect(human.stdout).toContain("Graph timeline");
    expect(human.stdout).toContain("src/tools/create-issue.ts:9");
  });

  it("focuses active findings on the local Git changed surface", async () => {
    const cwd = await tempRepo();
    const target = join(cwd, "demo-app");

    await cp(demoRoot, target, { recursive: true });
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "snitch@example.test"]);
    await git(cwd, ["config", "user.name", "Snitch Test"]);
    await git(cwd, ["add", "demo-app"]);
    await git(cwd, ["commit", "-m", "baseline"]);

    const toolPath = join(target, "src/tools/create-issue.ts");
    const originalTool = await readFile(toolPath, "utf8");
    await writeFile(toolPath, `${originalTool}\n// agent touched issue creation\n`, "utf8");
    await runCli(["analyze", "--target", target, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(["changed", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.git.available).toBe(true);
    expect(parsed.changedFiles[0]).toMatchObject({
      path: "demo-app/src/tools/create-issue.ts",
      targetPath: "src/tools/create-issue.ts",
      inAnalysisTarget: true
    });
    expect(parsed.counts.changedFindings).toBeGreaterThan(0);
    expect(parsed.changedFindings[0]).toMatchObject({
      finding: {
        warningId: "warning:tool_audit_log_missing:create_issue"
      },
      matchedFiles: ["src/tools/create-issue.ts"]
    });
    expect(parsed.nextCommands[0]).toContain("pnpm snitch trace --warning");

    const human = await runCli(["changed"], { cwd });

    expect(human.stdout).toContain("Snitch changed review");
    expect(human.stdout).toContain("Findings on changed files");
    expect(human.stdout).toContain("src/tools/create-issue.ts");
  });

  it("includes committed branch changes when diffing against a base ref", async () => {
    const cwd = await tempRepo();
    const target = join(cwd, "demo-app");

    await cp(demoRoot, target, { recursive: true });
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "snitch@example.test"]);
    await git(cwd, ["config", "user.name", "Snitch Test"]);
    await git(cwd, ["add", "demo-app"]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await git(cwd, ["branch", "base"]);

    const toolPath = join(target, "src/tools/create-issue.ts");
    const originalTool = await readFile(toolPath, "utf8");
    await writeFile(toolPath, `${originalTool}\n// committed issue tool touch\n`, "utf8");
    await git(cwd, ["add", "demo-app/src/tools/create-issue.ts"]);
    await git(cwd, ["commit", "-m", "touch issue tool"]);
    await runCli(["analyze", "--target", target, "--task", "Wire an issue tool"], { cwd, now });

    const result = await runCli(["changed", "--base", "base", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.git).toMatchObject({
      available: true,
      baseRef: "base",
      diffMode: "base"
    });
    expect(parsed.changedFiles).toHaveLength(1);
    expect(parsed.changedFiles[0]).toMatchObject({
      path: "demo-app/src/tools/create-issue.ts",
      targetPath: "src/tools/create-issue.ts",
      inAnalysisTarget: true
    });
    expect(parsed.counts.changedFindings).toBeGreaterThan(0);
  });

  it("serves Snitch tools over the MCP JSON-RPC handler", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], { cwd, now });

    const initialized = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "0.0.0"
        }
      }
    });
    const tools = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });
    const ping = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 3,
      method: "ping"
    });
    const doctor = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "snitch_doctor",
        arguments: {}
      }
    });
    const briefing = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "snitch_briefing",
        arguments: {
          task: "Add an external issue creation tool"
        }
      }
    });
    const check = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "snitch_check",
        arguments: {
          failOn: "medium"
        }
      }
    });
    const findings = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "snitch_findings",
        arguments: {}
      }
    });
    const nextAction = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "snitch_next_action",
        arguments: {}
      }
    });
    const trace = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "snitch_trace",
        arguments: {
          warning: "warning:tool_audit_log_missing:create_issue"
        }
      }
    });
    const changed = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "snitch_changed",
        arguments: {}
      }
    });
    const intent = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "snitch_verify_intent",
        arguments: {
          task: "Add an external issue creation tool"
        }
      }
    });
    const repairVerification = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "snitch_verify_repair",
        arguments: {
          warning: "warning:tool_audit_log_missing:create_issue"
        }
      }
    });
    const impact = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "snitch_impact",
        arguments: {
          warning: "warning:secret_redaction_missing:create_issue"
        }
      }
    });
    const repair = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "snitch_repair_prompt",
        arguments: {
          warning: "warning:secret_redaction_missing:create_issue"
        }
      }
    });

    const initializedResult = initialized as {
      result: { capabilities: { tools: { listChanged: boolean } } };
    };
    const toolsResult = tools as { result: { tools: Array<{ name: string }> } };
    const pingResult = ping as { result: Record<string, never> };
    const doctorResult = doctor as {
      result: {
        isError?: boolean;
        structuredContent: {
          ready: boolean;
          summary: {
            fail: number;
          };
          checks: Array<{
            id: string;
            status: string;
          }>;
        };
      };
    };
    const briefingResult = briefing as {
      result: {
        isError?: boolean;
        structuredContent: {
          status: string;
          intent: {
            status: string;
          };
          action: {
            topFinding?: {
              warningId: string;
            };
          };
          impact?: {
            files: string[];
          };
        };
      };
    };
    const checkResult = check as {
      result: {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          failOn: string;
          exitCode: number;
          counts: {
            blockingWarnings: number;
          };
        };
      };
    };
    const findingsResult = findings as {
      result: {
        isError?: boolean;
        structuredContent: {
          findings: Array<{
            warningId: string;
            anchor?: {
              file: string;
              line?: number;
            };
          }>;
        };
      };
    };
    const nextActionResult = nextAction as {
      result: {
        isError?: boolean;
        structuredContent: {
          status: string;
          topFinding?: {
            warningId: string;
          };
          nextCommands: string[];
        };
      };
    };
    const traceResult = trace as {
      result: {
        isError?: boolean;
        structuredContent: {
          status: string;
          warning: { id: string };
          finding?: {
            anchor?: {
              file: string;
            };
          };
          timeline: unknown[];
        };
      };
    };
    const changedResult = changed as {
      result: {
        isError?: boolean;
        structuredContent: {
          git: {
            available: boolean;
          };
          changedFindings: unknown[];
        };
      };
    };
    const intentResult = intent as {
      result: {
        isError?: boolean;
        structuredContent: {
          status: string;
          capabilities: Array<{ id: string }>;
          requirements: Array<{ id: string; status: string }>;
        };
      };
    };
    const repairVerificationResult = repairVerification as {
      result: {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          status: string;
          warningId: string;
        };
      };
    };
    const impactResult = impact as {
      result: {
        isError?: boolean;
        structuredContent: {
          warning: { id: string };
          nodes: Array<{ id: string }>;
        };
      };
    };
    const repairResult = repair as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
    };

    expect(initializedResult.result.capabilities.tools.listChanged).toBe(false);
    expect(pingResult.result).toEqual({});
    expect(toolsResult.result.tools.map((tool) => tool.name)).toEqual([
      "snitch_status",
      "snitch_doctor",
      "snitch_briefing",
      "snitch_check",
      "snitch_findings",
      "snitch_next_action",
      "snitch_trace",
      "snitch_changed",
      "snitch_verify_intent",
      "snitch_verify_repair",
      "snitch_impact",
      "snitch_repair_prompt"
    ]);
    expect(doctorResult.result.isError).toBe(false);
    expect(doctorResult.result.structuredContent.ready).toBe(false);
    expect(doctorResult.result.structuredContent.summary.fail).toBeGreaterThan(0);
    expect(doctorResult.result.structuredContent.checks).toContainEqual(
      expect.objectContaining({
        id: "hook-adapter",
        status: "fail"
      })
    );
    expect(briefingResult.result.isError).toBe(false);
    expect(briefingResult.result.structuredContent.status).toBe("action_required");
    expect(briefingResult.result.structuredContent.intent.status).toBe("partial");
    expect(briefingResult.result.structuredContent.action.topFinding?.warningId).toBe(
      "warning:tool_audit_log_missing:create_issue"
    );
    expect(briefingResult.result.structuredContent.impact?.files).toContain(
      "src/tools/create-issue.ts"
    );
    expect(checkResult.result.isError).toBe(true);
    expect(checkResult.result.structuredContent.ok).toBe(false);
    expect(checkResult.result.structuredContent.failOn).toBe("medium");
    expect(checkResult.result.structuredContent.exitCode).toBe(1);
    expect(checkResult.result.structuredContent.counts.blockingWarnings).toBe(4);
    expect(findingsResult.result.isError).toBe(false);
    expect(findingsResult.result.structuredContent.findings[0]).toMatchObject({
      warningId: "warning:tool_audit_log_missing:create_issue",
      anchor: {
        file: "src/tools/create-issue.ts",
        line: 9
      }
    });
    expect(nextActionResult.result.isError).toBe(false);
    expect(nextActionResult.result.structuredContent.status).toBe("action_required");
    expect(nextActionResult.result.structuredContent.topFinding?.warningId).toBe(
      "warning:tool_audit_log_missing:create_issue"
    );
    expect(nextActionResult.result.structuredContent.nextCommands[0]).toContain(
      "pnpm snitch repair-prompt --warning"
    );
    expect(nextActionResult.result.structuredContent.nextCommands).toContain(
      `pnpm snitch verify-repair --warning warning:tool_audit_log_missing:create_issue --target '${demoRoot}' --task 'Wire an issue tool' --json`
    );
    expect(traceResult.result.isError).toBe(false);
    expect(traceResult.result.structuredContent.status).toBe("traced");
    expect(traceResult.result.structuredContent.warning.id).toBe(
      "warning:tool_audit_log_missing:create_issue"
    );
    expect(traceResult.result.structuredContent.finding?.anchor?.file).toBe(
      "src/tools/create-issue.ts"
    );
    expect(traceResult.result.structuredContent.timeline.length).toBeGreaterThan(0);
    expect(changedResult.result.isError).toBe(false);
    expect(changedResult.result.structuredContent.git.available).toBe(false);
    expect(changedResult.result.structuredContent.changedFindings).toEqual([]);
    expect(intentResult.result.isError).toBe(false);
    expect(intentResult.result.structuredContent.status).toBe("partial");
    expect(intentResult.result.structuredContent.capabilities).toContainEqual(
      expect.objectContaining({
        id: "issue_creation"
      })
    );
    expect(intentResult.result.structuredContent.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:audit",
        status: "missing"
      })
    );
    expect(repairVerificationResult.result.isError).toBe(true);
    expect(repairVerificationResult.result.structuredContent).toMatchObject({
      ok: false,
      status: "still_active",
      warningId: "warning:tool_audit_log_missing:create_issue"
    });
    expect(impactResult.result.isError).toBe(false);
    expect(impactResult.result.structuredContent.warning.id).toBe(
      "warning:secret_redaction_missing:create_issue"
    );
    expect(impactResult.result.structuredContent.nodes.map((node) => node.id)).toContain(
      "tool:create_issue"
    );
    expect(repairResult.result.isError).toBe(false);
    expect(repairResult.result.content[0]?.text).toContain("Instruction for the coding agent:");
  });

  it("analyzes a TypeScript target into Snitch artifacts", async () => {
    const cwd = await tempRepo();
    const result = await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nodes: 11");
    await expect(readFile(join(cwd, ".snitch/config.json"), "utf8")).resolves.toContain(demoRoot);
    await expect(readFile(join(cwd, ".snitch/graph.json"), "utf8")).resolves.toContain(
      "api.github.com API"
    );
    await expect(readFile(join(cwd, ".snitch/pr-comment.md"), "utf8")).resolves.toContain(
      "No audit trail for external tool calls"
    );
    await expect(readFile(join(cwd, ".snitch/findings.json"), "utf8")).resolves.toContain(
      "src/tools/create-issue.ts"
    );
    await expect(readFile(join(cwd, ".snitch/next-action.md"), "utf8")).resolves.toContain(
      "Snitch Next Action"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.md"), "utf8")).resolves.toContain(
      "Snitch briefing"
    );

    const status = await runCli(["status", "--json"], { cwd });
    const parsedStatus = JSON.parse(status.stdout);

    expect(status.code).toBe(0);
    expect(parsedStatus.session.status).toBe("initialized");
    expect(parsedStatus.session.lastAnalyzedAt).toBeTruthy();
    expect(parsedStatus.counts.warnings).toBe(4);
    expect(parsedStatus.artifacts.briefing.available).toBe(true);
    expect(parsedStatus.artifacts.briefingJson.available).toBe(true);
  });

  it("fails check when warnings meet the severity threshold", async () => {
    const cwd = await tempRepo();
    const result = await runCli(["check", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Snitch check failed");
    expect(result.stdout).toContain("Fail on: high");
    expect(result.stdout).toContain("Blocking warnings: 2");
    expect(result.stdout).toContain("No audit trail for external tool calls");
    expect(result.stdout).toContain("pnpm snitch repair-prompt --warning warning:tool_audit_log_missing:create_issue");
    await expect(readFile(join(cwd, ".snitch/warnings.json"), "utf8")).resolves.toContain(
      "warning:tool_audit_log_missing:create_issue"
    );
  });

  it("prints JSON check output for CI consumers", async () => {
    const cwd = await tempRepo();
    const result = await runCli(
      ["check", "--target", demoRoot, "--task", "Wire an issue tool", "--fail-on", "medium", "--json"],
      {
        cwd,
        now
      }
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      failOn: string;
      counts: { warnings: number; blockingWarnings: number };
      blockingWarnings: Array<{ id: string; repairCommand: string }>;
    };

    expect(result.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.failOn).toBe("medium");
    expect(parsed.counts).toMatchObject({
      warnings: 4,
      blockingWarnings: 4
    });
    expect(parsed.blockingWarnings[0]?.repairCommand).toContain("pnpm snitch repair-prompt --warning");
  });

  it("passes check after companion warnings are repaired", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-check-repaired-"));
    const repairedRoot = join(tempRoot, "demo-app");
    const cwd = join(tempRoot, "workspace");
    tempDirs.push(tempRoot);
    await cp(demoRoot, repairedRoot, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await runCli(["analyze", "--cwd", cwd, "--target", repairedRoot, "--task", "Wire an issue tool"], {
      now
    });
    await applyDemoRepair({
      target: repairedRoot,
      artifactsDir: join(cwd, ".snitch"),
      now
    });

    const result = await runCli(["check", "--cwd", cwd, "--target", repairedRoot, "--task", "Wire an issue tool"], {
      now: new Date("2026-06-27T12:06:00.000Z")
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch check passed");
    expect(result.stdout).toContain("Blocking warnings: 0");
  });

  it("verifies whether a specific repair cleared its warning", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-verify-repair-"));
    const repairedRoot = join(tempRoot, "demo-app");
    const cwd = join(tempRoot, "workspace");
    tempDirs.push(tempRoot);
    await cp(demoRoot, repairedRoot, { recursive: true });
    await mkdir(cwd, { recursive: true });

    const active = await runCli(
      [
        "verify-repair",
        "--cwd",
        cwd,
        "--target",
        repairedRoot,
        "--task",
        "Wire an issue tool",
        "--warning",
        "warning:tool_audit_log_missing:create_issue",
        "--json"
      ],
      { now }
    );
    const activeParsed = JSON.parse(active.stdout);

    expect(active.code).toBe(1);
    expect(activeParsed).toMatchObject({
      ok: false,
      status: "still_active",
      warningId: "warning:tool_audit_log_missing:create_issue"
    });
    expect(activeParsed.nextCommands).toContain(
      "pnpm snitch repair-prompt --warning warning:tool_audit_log_missing:create_issue"
    );

    await applyDemoRepair({
      target: repairedRoot,
      artifactsDir: join(cwd, ".snitch"),
      now
    });

    const repaired = await runCli(
      [
        "verify-repair",
        "--cwd",
        cwd,
        "--target",
        repairedRoot,
        "--task",
        "Wire an issue tool",
        "--warning",
        "warning:tool_audit_log_missing:create_issue",
        "--json"
      ],
      { now: new Date("2026-06-27T12:07:00.000Z") }
    );
    const repairedParsed = JSON.parse(repaired.stdout);
    const human = await runCli(
      [
        "verify-repair",
        "--cwd",
        cwd,
        "--target",
        repairedRoot,
        "--task",
        "Wire an issue tool",
        "--warning",
        "warning:tool_audit_log_missing:create_issue"
      ],
      { now: new Date("2026-06-27T12:08:00.000Z") }
    );

    expect(repaired.code).toBe(0);
    expect(repairedParsed).toMatchObject({
      ok: true,
      status: "repaired",
      warningId: "warning:tool_audit_log_missing:create_issue",
      counts: {
        warnings: 0
      }
    });
    expect(repairedParsed.nextCommands).toContain(
      "pnpm snitch verify-intent --task 'Wire an issue tool' --json"
    );
    await expect(readFile(join(cwd, ".snitch/briefing.json"), "utf8")).resolves.toContain(
      "\"status\": \"clear\""
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Snitch repair verified.");
  });

  it("reads live dashboard state from Snitch artifacts", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });

    const state = await readLiveState(cwd);

    expect(state.ok).toBe(true);
    expect(state.graph.nodes.some((node) => node.label === "api.github.com API")).toBe(true);
    expect(state.warnings.some((warning) => warning.title === "No audit trail for external tool calls")).toBe(
      true
    );
    expect(state.events).toEqual([]);
    expect(state.artifacts.briefing).toContain("Snitch briefing");
    expect(state.artifacts.briefingJson).toContain("\"status\": \"action_required\"");
    expect(state.artifacts.mermaid).toContain("tool_create_issue");
    expect(state.artifacts.prComment).toContain("Snitch Review");
  });

  it("refreshes watched targets after filesystem changes without an agent hook", async () => {
    const cwd = await tempRepo();
    const target = join(cwd, "demo-target");

    await cp(demoRoot, target, { recursive: true });
    await runCli(["init", "--target", target, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    await runCli(["analyze", "--target", target, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    await mkdir(join(target, "src/lib"), { recursive: true });
    await writeFile(
      join(target, "src/lib/tool-audit-log.ts"),
      [
        "export const toolAuditLog = {",
        "  async write(record: unknown) {",
        "    return record;",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await refreshWatchedTarget(cwd, {
      target,
      now: new Date("2026-06-27T12:04:00.000Z"),
      refreshInsights: true
    });
    const state = await readLiveState(cwd);
    const timelineEntries = (await readFile(join(cwd, ".snitch/timeline.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        snapshotId: string;
        previousSnapshotId?: string;
        generatedAt?: string;
        source?: string;
        diffSummary: {
          addedNodes: number;
          removedNodes: number;
          addedEdges: number;
          removedEdges: number;
        };
      });
    const latestTimelineEntry = timelineEntries.at(-1);

    expect(result.status).toBe("updated");
    expect(result.insights).toEqual({
      refreshed: true
    });
    expect(
      state.graph.nodes.some((node) => node.id === "service:tool_audit_log" && node.meta?.role === "audit")
    ).toBe(true);
    expect(state.warnings.some((warning) => warning.id === "warning:tool_audit_log_missing:create_issue")).toBe(
      true
    );
    expect(state.insights).toMatchObject({
      generatedAt: "2026-06-27T12:04:00.000Z",
      cerebras: {
        status: "disabled",
        triageStatus: "disabled"
      },
      backboard: {
        status: "disabled"
      }
    });
    expect(state.session).toMatchObject({
      graphSource: "typescript",
      lastAnalyzedAt: "2026-06-27T12:04:00.000Z"
    });
    expect(timelineEntries.length).toBeGreaterThan(1);
    expect(latestTimelineEntry).toMatchObject({
      snapshotId: "extractor-ts",
      previousSnapshotId: "extractor-ts",
      generatedAt: "2026-06-27T12:04:00.000Z",
      source: "snitch-ts-extractor"
    });
    expect(latestTimelineEntry?.diffSummary).toMatchObject({
      addedNodes: 1,
      removedNodes: 0,
      addedEdges: 0,
      removedEdges: 0
    });
  });

  it("writes offline insight artifacts for the live dashboard", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    const result = await runCli(["insights", "--offline"], {
      cwd,
      now: new Date("2026-06-27T12:03:00.000Z")
    });
    const state = await readLiveState(cwd);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch insights artifact written");
    expect(result.stdout).toContain("Ranked warnings: 4");
    expect(state.insights?.cerebras.status).toBe("disabled");
    expect(state.insights?.cerebras.triageStatus).toBe("disabled");
    expect(state.insights?.backboard.status).toBe("disabled");
    expect(state.insights?.rankedWarnings).toHaveLength(4);
    expect(state.insights?.rankedWarnings[0]?.warningId).toBe(
      "warning:tool_audit_log_missing:create_issue"
    );
    expect(state.insights?.narration).toContain("Snitch saw 11 added nodes");
  });

  it("prints a paste-ready repair prompt for the next active warning", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    await runCli(["insights", "--offline"], {
      cwd,
      now: new Date("2026-06-27T12:03:00.000Z")
    });

    const result = await runCli(["repair-prompt"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Snitch Repair Prompt");
    expect(result.stdout).toContain("Warning: No audit trail for external tool calls");
    expect(result.stdout).toContain("Warning ID: warning:tool_audit_log_missing:create_issue");
    expect(result.stdout).toContain("Instruction for the coding agent:");
    expect(result.stdout).toContain("Add an audit log write around create_issue calls");
    expect(result.stdout).toContain("pnpm snitch verify-repair --warning warning:tool_audit_log_missing:create_issue");
    expect(result.stdout).toContain("Snitch repair verified.");
  });

  it("uses ranked warning insights when choosing the next repair prompt", async () => {
    const cwd = await tempRepo();

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    await writeFile(
      join(cwd, ".snitch/insights.json"),
      JSON.stringify(
        {
          generatedAt: "2026-06-27T12:04:00.000Z",
          narration: "Permission boundary first.",
          cerebras: {
            status: "ok",
            triageStatus: "ok"
          },
          backboard: {
            status: "disabled",
            rules: []
          },
          rankedWarnings: [
            {
              warningId: "warning:permission_scope_missing:create_issue",
              rank: 1,
              priority: "critical",
              reason: "The tool can create external issues without a task-scoped grant.",
              repairPrompt: "Gate create_issue behind a per-session permission grant before provider calls."
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runCli(["repair-prompt"], { cwd });
    const pinnedResult = await runCli(
      ["repair-prompt", "--warning", "warning:secret_redaction_missing:create_issue"],
      { cwd }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Warning: No per-session permission boundary");
    expect(result.stdout).toContain("Priority: #1 critical");
    expect(result.stdout).toContain("Why now: The tool can create external issues");
    expect(result.stdout).toContain("Gate create_issue behind a per-session permission grant");
    expect(pinnedResult.stdout).toContain("Warning: No secret redaction around provider data");
    expect(pinnedResult.stdout).not.toContain("No per-session permission boundary");
  });

  it("finalizes PR-ready artifacts from the background session", async () => {
    const cwd = await tempRepo();
    const originalBackboardApiKey = process.env.BACKBOARD_API_KEY;
    const originalBackboardAssistantId = process.env.BACKBOARD_ASSISTANT_ID;

    delete process.env.BACKBOARD_API_KEY;
    delete process.env.BACKBOARD_ASSISTANT_ID;

    await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });
    try {
      const result = await runCli(["finalize"], {
        cwd,
        now: new Date("2026-06-27T12:05:00.000Z")
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Backboard memory: disabled / 0 warning decisions");
      await expect(readFile(join(cwd, ".snitch/pr-comment.md"), "utf8")).resolves.toContain(
        "No audit trail for external tool calls"
      );
      await expect(readFile(join(cwd, ".snitch/session.json"), "utf8")).resolves.toContain(
        "\"status\": \"finalized\""
      );
      await expect(readFile(join(cwd, ".snitch/memory.json"), "utf8")).resolves.toContain(
        "\"status\": \"disabled\""
      );
    } finally {
      if (originalBackboardApiKey === undefined) {
        delete process.env.BACKBOARD_API_KEY;
      } else {
        process.env.BACKBOARD_API_KEY = originalBackboardApiKey;
      }

      if (originalBackboardAssistantId === undefined) {
        delete process.env.BACKBOARD_ASSISTANT_ID;
      } else {
        process.env.BACKBOARD_ASSISTANT_ID = originalBackboardAssistantId;
      }
    }
  });

  it("publishes the PR artifact as a GitHub issue comment", async () => {
    const cwd = await tempRepo();
    const calls: Array<{ url: string; method: string; body: string }> = [];

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    const result = await runCli(
      ["publish-github", "--repo", "acme/widgets", "--pr", "17", "--token", "ghs_test"],
      {
        cwd,
        fetcher: async (url, init) => {
          calls.push({
            url: String(url),
            method: String(init?.method ?? "GET"),
            body: String(init?.body ?? "")
          });

          if (String(init?.method ?? "GET") === "GET") {
            return new Response(JSON.stringify([]), { status: 200 });
          }

          return new Response(
            JSON.stringify({
              id: 10,
              html_url: "https://github.com/acme/widgets/pull/17#issuecomment-10"
            }),
            { status: 201 }
          );
        }
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch created the PR summary comment");
    expect(result.stdout).not.toContain("ghs_test");
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues/17/comments?per_page=100"
    );
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/widgets/issues/17/comments");
    expect(calls[1]?.body).toContain("<!-- snitch-pr-summary -->");
    expect(calls[1]?.body).toContain("Snitch Review");
  });

  it("updates the existing Snitch PR comment when the marker is present", async () => {
    const cwd = await tempRepo();
    const calls: Array<{ url: string; method: string; body: string }> = [];

    await runCli(["analyze", "--target", demoRoot, "--task", "Wire an issue tool"], {
      cwd,
      now
    });
    const result = await runCli(
      ["publish-github", "--repo", "acme/widgets", "--pr", "17", "--token", "ghs_test"],
      {
        cwd,
        fetcher: async (url, init) => {
          const method = String(init?.method ?? "GET");
          calls.push({
            url: String(url),
            method,
            body: String(init?.body ?? "")
          });

          if (method === "GET") {
            return new Response(
              JSON.stringify([
                {
                  id: 22,
                  body: "<!-- snitch-pr-summary -->\nold body"
                }
              ]),
              { status: 200 }
            );
          }

          return new Response(
            JSON.stringify({
              id: 22,
              html_url: "https://github.com/acme/widgets/pull/17#issuecomment-22"
            }),
            { status: 200 }
          );
        }
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch updated the PR summary comment");
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/widgets/issues/comments/22");
    expect(calls[1]?.body).toContain("<!-- snitch-pr-summary -->");
    expect(calls[1]?.body).toContain("Snitch Review");
  });

  it("prints the version", async () => {
    const result = await runCli(["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Snitch v\d/);
  });

  it("shows grouped help with no command", async () => {
    const result = await runCli([]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daily loop:");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("Quick start");
  });

  it("shows per-command help with --help", async () => {
    const result = await runCli(["repair-prompt", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("snitch repair-prompt —");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--warning");
  });

  it("rejects an unknown command with a suggestion and nonzero exit", async () => {
    const result = await runCli(["statuss"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command: statuss");
    expect(result.stderr).toContain("snitch status");
  });

  it("guides the user when the repo is not initialized", async () => {
    const cwd = await tempRepo();

    const result = await runCli(["status"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("isn't initialized");
    expect(result.stderr).toContain("snitch init");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("parses --key=value flags without corrupting the value", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--task=Build a webhook with retries"], { cwd, now });
    const status = await runCli(["status", "--json"], { cwd });
    const parsed = JSON.parse(status.stdout) as { session: { task: string } };

    expect(parsed.session.task).toBe("Build a webhook with retries");
  });

  it("preserves the stored task across analyze instead of reverting to the default", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--target", demoRoot, "--task", "Add an external issue tool"], { cwd, now });
    await runCli(["analyze", "--target", demoRoot], { cwd, now });
    const status = await runCli(["status", "--json"], { cwd });
    const parsed = JSON.parse(status.stdout) as { session: { task: string } };

    expect(parsed.session.task).toBe("Add an external issue tool");
  });

  it("updates the stored live task when analyze receives an explicit task", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--target", demoRoot, "--task", "Old demo task"], { cwd, now });
    await runCli(["analyze", "--target", demoRoot, "--task", "Dogfood this repository"], { cwd, now });
    const status = await runCli(["status", "--json"], { cwd });
    const parsed = JSON.parse(status.stdout) as { session: { task: string } };

    expect(parsed.session.task).toBe("Dogfood this repository");
  });
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snitch-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: withoutGitLocalEnv() });
}

function withoutGitLocalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };

  for (const name of gitLocalEnvNames) {
    delete next[name];
  }

  return next;
}
