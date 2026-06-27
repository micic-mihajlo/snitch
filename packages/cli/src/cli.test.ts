import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLiveState, runCli } from "./cli";

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
    expect(state.artifacts.mermaid).toContain("tool_create_issue");
    expect(state.artifacts.prComment).toContain("Snitch Review");
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
