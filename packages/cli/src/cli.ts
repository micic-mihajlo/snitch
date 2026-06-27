import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

type SnitchEvent = {
  id: string;
  receivedAt: string;
  source: string;
  hook: string;
  payloadHash: string;
  payloadBytes: number;
  payloadSummary: Record<string, string | number | boolean>;
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
      const message = await initializeSnitch(cwd, task, now);
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

async function initializeSnitch(cwd: string, task: string, now: Date): Promise<string> {
  await ensureDirs(cwd);

  const createdAt = now.toISOString();
  const replay = getDemoReplay();
  const baseline = replay[0] ?? getReviewSnapshot(replay);
  const runId = createRunId(now);
  const config: SnitchConfig = {
    version: 1,
    project: basename(cwd) || "repo",
    mode: "background-companion",
    autoInject: true,
    includeFiles: true,
    artifactsDir: ".snitch",
    hookAdapter: hookFile,
    hookCommand: "node .snitch/hooks/codex-hook.mjs <hook-name>",
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
  const event = createEvent(input);
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

function createEvent(input: { source: string; hook: string; stdin: string; now: Date }): SnitchEvent {
  const payload = input.stdin.trim();
  const receivedAt = input.now.toISOString();
  const safeSummary = summarizePayload(payload);

  return {
    id: `event:${receivedAt}:${hashText(`${input.source}:${input.hook}:${payload}`).slice(0, 12)}`,
    receivedAt,
    source: input.source,
    hook: input.hook,
    payloadHash: hashText(payload),
    payloadBytes: Buffer.byteLength(input.stdin),
    payloadSummary: safeSummary
  };
}

function summarizePayload(payload: string): Record<string, string | number | boolean> {
  if (!payload) {
    return { kind: "empty" };
  }

  try {
    const parsed = JSON.parse(payload) as unknown;

    if (!isRecord(parsed)) {
      return { kind: "json", valueType: typeof parsed };
    }

    const summary: Record<string, string | number | boolean> = { kind: "json" };
    const safeKeys = [
      "hook",
      "event",
      "tool",
      "tool_name",
      "file",
      "file_path",
      "path",
      "status",
      "exit_code"
    ];

    for (const key of safeKeys) {
      const value = parsed[key];

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        summary[key] = typeof value === "string" ? truncate(value, 160) : value;
      }
    }

    const command = parsed.command;

    if (typeof command === "string") {
      summary.commandHash = hashText(command);
      summary.commandBytes = Buffer.byteLength(command);
    }

    return summary;
  } catch {
    return {
      kind: "text",
      bytes: Buffer.byteLength(payload)
    };
  }
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
    "  snitch init [--cwd <repo>] [--task <task>]",
    "  snitch event [--cwd <repo>] [--source <agent>] [--hook <hook>] < stdin-json",
    "  snitch status [--cwd <repo>]",
    "  snitch finalize [--cwd <repo>]"
  ].join("\n") + "\n";
}

function createRunId(now: Date): string {
  return `snitch-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
