import { createHash } from "node:crypto";

export type SnitchEventSource = "codex" | "claude" | "opencode" | "git" | "watcher" | "replay" | "agent";

export type SnitchEventPhase =
  | "session_start"
  | "prompt"
  | "tool_before"
  | "tool_after"
  | "file_changed"
  | "graph_updated"
  | "warning_created"
  | "repair_prompt_created"
  | "session_stop"
  | "agent_event";

export type SnitchEventEvidence = {
  file: string;
  line?: number;
  symbolId?: string;
};

export type SnitchEvent = {
  id: string;
  runId: string;
  parentId?: string;
  source: SnitchEventSource;
  phase: SnitchEventPhase;
  hook: string;
  receivedAt: string;
  payloadHash: string;
  payloadBytes: number;
  safeSummary: Record<string, string | number | boolean>;
  evidence?: SnitchEventEvidence[];
};

export type NormalizeEventInput = {
  runId: string;
  source: string;
  hook: string;
  stdin: string;
  receivedAt: Date;
  parentId?: string;
};

export function normalizeSnitchEvent(input: NormalizeEventInput): SnitchEvent {
  const payload = input.stdin.trim();
  const receivedAt = input.receivedAt.toISOString();
  const source = normalizeSource(input.source);
  const phase = inferPhase(input.hook);
  const evidence = extractEvidence(payload);
  const event: SnitchEvent = {
    id: `event:${receivedAt}:${hashText(`${input.runId}:${input.source}:${input.hook}:${payload}`).slice(0, 12)}`,
    runId: input.runId,
    source,
    phase,
    hook: input.hook,
    receivedAt,
    payloadHash: hashText(payload),
    payloadBytes: Buffer.byteLength(input.stdin),
    safeSummary: summarizePayload(payload)
  };

  if (input.parentId) {
    event.parentId = input.parentId;
  }

  if (evidence.length > 0) {
    event.evidence = evidence;
  }

  return event;
}

export function summarizePayload(payload: string): Record<string, string | number | boolean> {
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

export function inferPhase(hook: string): SnitchEventPhase {
  const normalized = hook.toLowerCase();

  if (normalized.includes("sessionstart") || normalized.includes("session.created")) {
    return "session_start";
  }

  if (normalized.includes("userprompt") || normalized.includes("prompt")) {
    return "prompt";
  }

  if (normalized.includes("pretool") || normalized.includes("tool.execute.before")) {
    return "tool_before";
  }

  if (normalized.includes("posttool") || normalized.includes("tool.execute.after")) {
    return "tool_after";
  }

  if (normalized.includes("file") || normalized.includes("watcher")) {
    return "file_changed";
  }

  if (normalized.includes("stop") || normalized.includes("sessionend") || normalized.includes("session.idle")) {
    return "session_stop";
  }

  return "agent_event";
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSource(source: string): SnitchEventSource {
  if (
    source === "codex" ||
    source === "claude" ||
    source === "opencode" ||
    source === "git" ||
    source === "watcher" ||
    source === "replay"
  ) {
    return source;
  }

  return "agent";
}

function extractEvidence(payload: string): SnitchEventEvidence[] {
  try {
    const parsed = JSON.parse(payload) as unknown;

    if (!isRecord(parsed)) {
      return [];
    }

    const evidence: SnitchEventEvidence[] = [];

    for (const key of ["file_path", "file", "path"]) {
      const value = parsed[key];

      if (typeof value === "string" && looksLikeSourcePath(value)) {
        const line = typeof parsed.line === "number" ? parsed.line : undefined;
        evidence.push(line ? { file: value, line } : { file: value });
      }
    }

    return dedupeEvidence(evidence);
  } catch {
    return [];
  }
}

function dedupeEvidence(evidence: SnitchEventEvidence[]): SnitchEventEvidence[] {
  const seen = new Set<string>();
  const result: SnitchEventEvidence[] = [];

  for (const item of evidence) {
    const key = `${item.file}:${item.line ?? ""}:${item.symbolId ?? ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

function looksLikeSourcePath(value: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx|json|md)$/.test(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
