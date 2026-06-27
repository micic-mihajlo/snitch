import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSnitchEvent, type SnitchEvent } from "@snitch/events";
import { extractTypeScriptGraph } from "@snitch/extractor-ts";
import {
  buildSnitchArtifacts,
  getDemoReplay,
  getReviewSnapshot,
  type ReplaySnapshot,
  type SnitchArtifacts
} from "../../graph/src/index";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunCliOptions = {
  cwd?: string;
  stdin?: string;
  now?: Date;
};

type AgentTarget = "codex" | "claude" | "opencode";

type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | true>;
};

type SnitchConfig = {
  version: 1;
  project: string;
  mode: "background-companion";
  autoInject: true;
  includeFiles: true;
  artifactsDir: ".snitch";
  hookAdapter: ".snitch/hooks/codex-hook.mjs";
  hookCommand: string;
  agents: AgentTarget[];
  generatedConfigs: string[];
  createdAt: string;
};

type SnitchSession = {
  runId: string;
  task: string;
  status: "initialized" | "running" | "finalized";
  source: "snitch-background";
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  snapshotId: string;
  eventsPath: ".snitch/events.jsonl";
  artifacts: Array<keyof SnitchArtifacts>;
};

const eventsFile = ".snitch/events.jsonl";
const hookFile = ".snitch/hooks/codex-hook.mjs";
const defaultTask =
  "Watch this coding-agent session and expose graph changes, warnings, and PR-ready handoff artifacts.";

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const parsed = parseArgs(args);
  const command = parsed.positional[0] ?? "help";
  const cwd = resolve(String(parsed.flags.get("cwd") ?? options.cwd ?? process.cwd()));
  const now = options.now ?? new Date();

  try {
    if (command === "init") {
      const task = String(parsed.flags.get("task") ?? defaultTask);
      const agents = parseAgents(parsed.flags.get("agent"));
      const message = await initializeSnitch(cwd, task, now, agents);
      return ok(message);
    }

    if (command === "event") {
      const source = String(parsed.flags.get("source") ?? "agent");
      const hook = String(parsed.flags.get("hook") ?? parsed.positional[1] ?? "agent-event");
      const message = await recordSnitchEvent(cwd, {
        source,
        hook,
        stdin: options.stdin ?? "",
        now
      });
      return ok(message);
    }

    if (command === "status") {
      return ok(await readSnitchStatus(cwd));
    }

    if (command === "analyze") {
      const target = resolve(cwd, String(parsed.flags.get("target") ?? "."));
      const task = String(parsed.flags.get("task") ?? defaultTask);
      return ok(await analyzeTypeScriptRepo(cwd, target, task, now));
    }

    if (command === "finalize") {
      const message = await finalizeSnitch(cwd, now);
      return ok(message);
    }

    return ok(helpText());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stdout: "",
      stderr: `Snitch failed: ${message}\n`
    };
  }
}

async function analyzeTypeScriptRepo(
  cwd: string,
  target: string,
  task: string,
  now: Date
): Promise<string> {
  const extracted = extractTypeScriptGraph({
    cwd: target,
    title: `Extracted graph for ${basename(target) || "repo"}`,
    generatedAt: now.toISOString()
  });
  const artifacts = buildSnitchArtifacts({
    replay: [extracted.snapshot],
    reviewSnapshot: extracted.snapshot,
    createdAt: now.toISOString(),
    runId: `snitch-analyze-${basename(target) || "repo"}`,
    task,
    source: "snitch-ts-extractor"
  });

  await writeArtifacts(cwd, artifacts);

  return [
    `Snitch analyzed ${target}.`,
    `- Nodes: ${extracted.snapshot.graph.nodes.length}`,
    `- Edges: ${extracted.snapshot.graph.edges.length}`,
    `- Warnings: ${extracted.snapshot.warnings.length}`,
    "- Updated: .snitch/graph.json, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function initializeSnitch(
  cwd: string,
  task: string,
  now: Date,
  agents: AgentTarget[] = ["codex"]
): Promise<string> {
  await ensureDirs(cwd);

  const createdAt = now.toISOString();
  const replay = getDemoReplay();
  const baseline = replay[0] ?? getReviewSnapshot(replay);
  const runId = createRunId(now);
  const generatedConfigs = generatedConfigPaths(agents);
  const config: SnitchConfig = {
    version: 1,
    project: basename(cwd) || "repo",
    mode: "background-companion",
    autoInject: true,
    includeFiles: true,
    artifactsDir: ".snitch",
    hookAdapter: hookFile,
    hookCommand: "node .snitch/hooks/codex-hook.mjs <hook-name>",
    agents,
    generatedConfigs,
    createdAt
  };
  const session = createSession({
    runId,
    task,
    status: "initialized",
    startedAt: createdAt,
    lastEventAt: createdAt,
    eventCount: 0,
    snapshotId: baseline.id
  });

  await writeJson(cwd, ".snitch/config.json", config);
  await writeText(cwd, hookFile, createCodexHookAdapter());
  await chmod(resolve(cwd, hookFile), 0o755);
  await writeAgentConfigs(cwd, agents);
  await writeReplayArtifacts(cwd, {
    replay,
    snapshot: baseline,
    runId,
    task,
    createdAt,
    source: "snitch-background"
  });
  await writeJson(cwd, ".snitch/session.json", session);
  await writeJsonl(cwd, eventsFile, []);

  return [
    "Snitch background companion initialized.",
    `- Hook adapter: ${hookFile}`,
    `- Agent command: node ${hookFile} <hook-name>`,
    `- Agent configs: ${generatedConfigs.join(", ")}`,
    "- Local state: .snitch/config.json, .snitch/session.json, .snitch/events.jsonl",
    "- Artifacts: .snitch/graph.json, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function recordSnitchEvent(
  cwd: string,
  input: { source: string; hook: string; stdin: string; now: Date }
): Promise<string> {
  await ensureInitialized(cwd, input.now);

  const session = await readSession(cwd);
  const events = await readEvents(cwd);
  const event = normalizeSnitchEvent({
    runId: session.runId,
    source: input.source,
    hook: input.hook,
    stdin: input.stdin,
    receivedAt: input.now
  });
  const nextEvents = [...events, event];
  const replay = getDemoReplay();
  const snapshot = pickSnapshotForEventCount(replay, nextEvents.length);
  const updatedSession = {
    ...session,
    status: "running",
    lastEventAt: input.now.toISOString(),
    eventCount: nextEvents.length,
    snapshotId: snapshot.id
  } satisfies SnitchSession;

  await writeJsonl(cwd, eventsFile, nextEvents);
  await writeJson(cwd, ".snitch/session.json", updatedSession);
  await writeReplayArtifacts(cwd, {
    replay,
    snapshot,
    runId: session.runId,
    task: session.task,
    createdAt: session.startedAt,
    source: "snitch-background"
  });
  await writeJson(cwd, ".snitch/session.json", updatedSession);

  return [
    `Snitch captured ${input.source}:${input.hook}.`,
    `- Events: ${nextEvents.length}`,
    `- Snapshot: ${snapshot.title}`,
    "- Updated: .snitch/graph.json, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function finalizeSnitch(cwd: string, now: Date): Promise<string> {
  await ensureInitialized(cwd, now);

  const session = await readSession(cwd);
  const replay = getDemoReplay();
  const reviewSnapshot = getReviewSnapshot(replay);
  const updatedSession = {
    ...session,
    status: "finalized",
    lastEventAt: now.toISOString(),
    snapshotId: reviewSnapshot.id
  } satisfies SnitchSession;

  await writeReplayArtifacts(cwd, {
    replay,
    snapshot: reviewSnapshot,
    runId: session.runId,
    task: session.task,
    createdAt: session.startedAt,
    source: "snitch-background"
  });
  await writeJson(cwd, ".snitch/session.json", updatedSession);

  return [
    "Snitch finalized the background session.",
    "- PR body: .snitch/pr-comment.md",
    "- Handoff: .snitch/handoff.md",
    "- Mermaid: .snitch/mermaid.mmd"
  ].join("\n") + "\n";
}

async function readSnitchStatus(cwd: string): Promise<string> {
  const session = await readSession(cwd);
  const events = await readEvents(cwd);

  return [
    "Snitch background companion",
    `- Status: ${session.status}`,
    `- Task: ${session.task}`,
    `- Events: ${events.length}`,
    `- Current snapshot: ${session.snapshotId}`,
    `- Hook adapter: ${hookFile}`,
    "- Configure your coding agent to run: node .snitch/hooks/codex-hook.mjs <hook-name>"
  ].join("\n") + "\n";
}

async function ensureInitialized(cwd: string, now: Date): Promise<void> {
  try {
    await readFile(resolve(cwd, ".snitch/session.json"), "utf8");
  } catch {
    await initializeSnitch(cwd, defaultTask, now);
  }
}

async function ensureDirs(cwd: string): Promise<void> {
  await mkdir(resolve(cwd, ".snitch/hooks"), { recursive: true });
}

function pickSnapshotForEventCount(replay: ReplaySnapshot[], eventCount: number): ReplaySnapshot {
  if (replay.length === 0) {
    throw new Error("Snitch replay is empty.");
  }

  const index = Math.min(eventCount, replay.length - 1);
  const snapshot = replay[index];

  if (!snapshot) {
    throw new Error(`Snitch replay is missing snapshot ${index}.`);
  }

  return snapshot;
}

async function writeReplayArtifacts(
  cwd: string,
  input: {
    replay: ReplaySnapshot[];
    snapshot: ReplaySnapshot;
    runId: string;
    task: string;
    createdAt: string;
    source: "snitch-background";
  }
): Promise<void> {
  const artifacts = buildSnitchArtifacts({
    replay: input.replay,
    reviewSnapshot: input.snapshot,
    createdAt: input.createdAt,
    runId: input.runId,
    task: input.task,
    source: input.source
  });

  await writeArtifacts(cwd, artifacts);
}

async function writeArtifacts(cwd: string, artifacts: SnitchArtifacts): Promise<void> {
  await Promise.all(
    Object.entries(artifacts).map(([name, contents]) => writeText(cwd, `.snitch/${name}`, contents))
  );
}

function createSession(input: {
  runId: string;
  task: string;
  status: SnitchSession["status"];
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  snapshotId: string;
}): SnitchSession {
  return {
    runId: input.runId,
    task: input.task,
    status: input.status,
    source: "snitch-background",
    startedAt: input.startedAt,
    lastEventAt: input.lastEventAt,
    eventCount: input.eventCount,
    snapshotId: input.snapshotId,
    eventsPath: eventsFile,
    artifacts: ["graph.json", "timeline.jsonl", "mermaid.mmd", "handoff.md", "pr-comment.md"]
  };
}

function createCodexHookAdapter(): string {
  const snitchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const input = readFileSync(0, "utf8");
const hook = process.env.SNITCH_HOOK_NAME || process.env.CODEX_HOOK_NAME || process.argv[2] || "agent-event";
const source = process.env.SNITCH_SOURCE || "codex";
const result = spawnSync(
  "pnpm",
  ["--dir", ${JSON.stringify(snitchRoot)}, "snitch", "event", "--cwd", process.cwd(), "--source", source, "--hook", hook],
  {
    input,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"]
  }
);

process.exit(result.status ?? 1);
`;
}

async function writeAgentConfigs(cwd: string, agents: AgentTarget[]): Promise<void> {
  await Promise.all(
    agents.map(async (agent) => {
      if (agent === "codex") {
        await writeJson(cwd, ".codex/hooks.json", createCodexHooksConfig());
      }

      if (agent === "claude") {
        await writeJson(cwd, ".claude/settings.local.json", createClaudeHooksConfig());
      }

      if (agent === "opencode") {
        await writeText(cwd, ".opencode/snitch-plugin.ts", createOpenCodePlugin());
      }
    })
  );
}

function createCodexHooksConfig(): unknown {
  return {
    hooks: {
      SessionStart: [codexHook("SessionStart", "Snitch session start")],
      PostToolUse: [codexHook("PostToolUse", "Snitch captured tool output")],
      Stop: [codexHook("Stop", "Snitch finalized session")]
    }
  };
}

function codexHook(hook: string, statusMessage: string): unknown {
  return {
    hooks: [
      {
        type: "command",
        command: `node .snitch/hooks/codex-hook.mjs ${hook}`,
        timeout: 30,
        statusMessage
      }
    ]
  };
}

function createClaudeHooksConfig(): unknown {
  return {
    hooks: {
      SessionStart: [claudeHook("SessionStart")],
      PostToolUse: [claudeHook("PostToolUse")],
      Stop: [claudeHook("Stop")]
    }
  };
}

function claudeHook(hook: string): unknown {
  return {
    hooks: [
      {
        type: "command",
        command: `SNITCH_SOURCE=claude node .snitch/hooks/codex-hook.mjs ${hook}`,
        timeout: 30
      }
    ]
  };
}

function createOpenCodePlugin(): string {
  return `export default function snitchPlugin() {
  const run = async (event, payload) => {
    const proc = Bun.spawn([
      "node",
      ".snitch/hooks/codex-hook.mjs",
      event
    ], {
      stdin: "pipe",
      env: {
        ...Bun.env,
        SNITCH_SOURCE: "opencode"
      }
    });
    proc.stdin.write(JSON.stringify(payload ?? {}));
    proc.stdin.end();
    await proc.exited;
  };

  return {
    event: async ({ event, properties }) => {
      if (event === "tool.execute.after" || event === "file.edited" || event === "session.idle") {
        await run(event, properties);
      }
    }
  };
}
`;
}

function generatedConfigPaths(agents: AgentTarget[]): string[] {
  const paths: string[] = [];

  if (agents.includes("codex")) {
    paths.push(".codex/hooks.json");
  }

  if (agents.includes("claude")) {
    paths.push(".claude/settings.local.json");
  }

  if (agents.includes("opencode")) {
    paths.push(".opencode/snitch-plugin.ts");
  }

  return paths;
}

async function readSession(cwd: string): Promise<SnitchSession> {
  const contents = await readFile(resolve(cwd, ".snitch/session.json"), "utf8");
  return JSON.parse(contents) as SnitchSession;
}

async function readEvents(cwd: string): Promise<SnitchEvent[]> {
  try {
    const contents = await readFile(resolve(cwd, eventsFile), "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SnitchEvent);
  } catch {
    return [];
  }
}

async function writeJson(cwd: string, path: string, value: unknown): Promise<void> {
  await writeText(cwd, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(cwd: string, path: string, values: unknown[]): Promise<void> {
  await writeText(cwd, path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

async function writeText(cwd: string, path: string, contents: string): Promise<void> {
  await mkdir(dirname(resolve(cwd, path)), { recursive: true });
  await writeFile(resolve(cwd, path), contents, "utf8");
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg?.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[index + 1];

      if (next && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
    } else if (arg) {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function parseAgents(value: string | true | undefined): AgentTarget[] {
  if (!value || value === true) {
    return ["codex"];
  }

  const rawAgents = value.split(",").map((agent) => agent.trim()).filter(Boolean);
  const agents = rawAgents.includes("all") ? ["codex", "claude", "opencode"] : rawAgents;
  const validAgents = agents.filter(isAgentTarget);

  return validAgents.length > 0 ? unique(validAgents) : ["codex"];
}

function isAgentTarget(value: string): value is AgentTarget {
  return value === "codex" || value === "claude" || value === "opencode";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function ok(stdout: string): CliResult {
  return {
    code: 0,
    stdout,
    stderr: ""
  };
}

function helpText(): string {
  return [
    "Snitch background companion",
    "",
    "Commands:",
    "  snitch init [--cwd <repo>] [--agent codex|claude|opencode|all] [--task <task>]",
    "  snitch event [--cwd <repo>] [--source <agent>] [--hook <hook>] < stdin-json",
    "  snitch analyze [--cwd <output-repo>] [--target <ts-repo>] [--task <task>]",
    "  snitch status [--cwd <repo>]",
    "  snitch finalize [--cwd <repo>]"
  ].join("\n") + "\n";
}

function createRunId(now: Date): string {
  return `snitch-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}
