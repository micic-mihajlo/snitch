import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli";

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

    const hookStats = await stat(join(cwd, ".snitch/hooks/codex-hook.mjs"));
    expect(hookStats.mode & 0o111).toBeGreaterThan(0);
  });

  it("can generate Codex, Claude, and OpenCode background adapter configs", async () => {
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
    expect(result.stdout).toContain(".claude/settings.local.json");
    expect(result.stdout).toContain(".opencode/snitch-plugin.ts");
    expect(result.stdout).toContain(`Analysis target: ${demoRoot}`);
    await expect(readFile(join(cwd, ".codex/hooks.json"), "utf8")).resolves.toContain(
      "PostToolUse"
    );
    await expect(readFile(join(cwd, ".claude/settings.local.json"), "utf8")).resolves.toContain(
      "SNITCH_SOURCE=claude"
    );
    await expect(readFile(join(cwd, ".opencode/snitch-plugin.ts"), "utf8")).resolves.toContain(
      "tool.execute.after"
    );
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
    const events = await readFile(join(cwd, ".snitch/events.jsonl"), "utf8");
    expect(events).toContain("apply_patch");
    expect(events).toContain("src/tools/issues.ts");
    expect(events).not.toContain("do-not-store-this");
    expect(events).not.toContain("run-with-private-value");
    expect(events).toContain("commandHash");
    await expect(readFile(join(cwd, ".snitch/graph.json"), "utf8")).resolves.toContain(
      "Create issue tool"
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

  it("prints status for the agent background loop", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });
    const result = await runCli(["status"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Snitch background companion");
    expect(result.stdout).toContain("node .snitch/hooks/codex-hook.mjs");
    expect(result.stdout).toContain("Analysis target: .");
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
  });

  it("finalizes PR-ready artifacts from the background session", async () => {
    const cwd = await tempRepo();

    await runCli(["init", "--task", "Wire an issue tool"], { cwd, now });
    const result = await runCli(["finalize"], {
      cwd,
      now: new Date("2026-06-27T12:05:00.000Z")
    });

    expect(result.code).toBe(0);
    await expect(readFile(join(cwd, ".snitch/pr-comment.md"), "utf8")).resolves.toContain(
      "No audit trail for external tool calls"
    );
    await expect(readFile(join(cwd, ".snitch/session.json"), "utf8")).resolves.toContain(
      "\"status\": \"finalized\""
    );
  });
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snitch-cli-"));
  tempDirs.push(dir);
  return dir;
}
