import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    expect(result.stdout).toContain(".opencode/snitch-plugin.ts");
    expect(result.stdout).toContain(`Analysis target: ${demoRoot}`);
    await expect(readFile(join(cwd, ".codex/hooks.json"), "utf8")).resolves.toContain(
      "PostToolUse"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "Snitch local verification"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch check"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch repair-prompt"
    );
    await expect(readFile(join(cwd, ".cursor/rules/snitch.mdc"), "utf8")).resolves.toContain(
      "pnpm snitch next-action"
    );
    await expect(readFile(join(cwd, ".claude/settings.local.json"), "utf8")).resolves.toContain(
      "SNITCH_SOURCE=claude"
    );
    await expect(readFile(join(cwd, ".opencode/snitch-plugin.ts"), "utf8")).resolves.toContain(
      "tool.execute.after"
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
    expect(result.stdout).toContain("node .snitch/hooks/codex-hook.mjs");
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
    expect(parsed.nextCommands).toContain("pnpm snitch next-action --json");
    expect(parsed.nextCommands).toContain(
      `pnpm snitch check --target ${demoRoot} --fail-on medium --json`
    );
    expect(JSON.stringify(parsed)).toContain("commandHash");
    expect(JSON.stringify(parsed)).not.toContain("private-status-secret");
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
    const impact = await handleMcpJsonRpcMessage(cwd, {
      jsonrpc: "2.0",
      id: 7,
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
      id: 8,
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
      "snitch_check",
      "snitch_findings",
      "snitch_next_action",
      "snitch_impact",
      "snitch_repair_prompt"
    ]);
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
    expect(result.stdout).toContain("Nodes: 10");
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

    const status = await runCli(["status", "--json"], { cwd });
    const parsedStatus = JSON.parse(status.stdout);

    expect(status.code).toBe(0);
    expect(parsedStatus.session.status).toBe("initialized");
    expect(parsedStatus.session.lastAnalyzedAt).toBeTruthy();
    expect(parsedStatus.counts.warnings).toBe(4);
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
      now: new Date("2026-06-27T12:04:00.000Z")
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
    expect(state.graph.nodes.some((node) => node.id === "service:tool_audit_log")).toBe(true);
    expect(state.graph.nodes.some((node) => node.label === "Tool audit log")).toBe(true);
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
      removedNodes: 1,
      addedEdges: 1,
      removedEdges: 1
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
    expect(state.insights?.narration).toContain("Snitch saw 10 added nodes");
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
    expect(result.stdout).toContain("Confirm warning `warning:tool_audit_log_missing:create_issue` is gone");
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
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snitch-cli-"));
  tempDirs.push(dir);
  return dir;
}
