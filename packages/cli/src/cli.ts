import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeSnitchEvent, type SnitchEvent } from "@snitch/events";
import { extractTypeScriptGraph } from "@snitch/extractor-ts";
import {
  buildSnitchFindings,
  buildSnitchArtifacts,
  createCerebrasNarrationInput,
  createCerebrasWarningTriageInput,
  createStaticNarration,
  diffGraph,
  getDemoReplay,
  getReviewSnapshot,
  loadBackboardRepoRules,
  narrateWithCerebras,
  rankWarningsWithCerebras,
  rememberBackboardWarningDecision,
  scopeGraph,
  type RankedWarning,
  type ReplaySnapshot,
  type SnitchArtifacts,
  type SnitchFinding,
  type SnitchGraph,
  type SnitchWarning,
  type IntegrationStatus
} from "../../graph/src/index";

const execFileAsync = promisify(execFile);

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunCliOptions = {
  cwd?: string;
  stdin?: string;
  now?: Date;
  fetcher?: typeof fetch;
};

type AgentTarget = "codex" | "cursor" | "claude" | "opencode";
type GraphSource = "replay" | "typescript";

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
  analysis: {
    engine: "typescript";
    target: string;
    refreshOn: "file-event";
  };
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
  graphSource: GraphSource;
  analysisTarget: string;
  lastAnalyzedAt?: string;
  lastAnalysisError?: string;
  eventsPath: ".snitch/events.jsonl";
  artifacts: Array<keyof SnitchArtifacts>;
};

type AnalysisWriteResult = {
  snapshot: ReplaySnapshot;
  graphSource: "typescript";
  target: string;
  analyzedAt: string;
};

type TimelineEntry = {
  snapshotId: string;
  title: string;
  description: string;
  warningCount: number;
  diffSummary: ReturnType<typeof diffGraph>["summary"];
  generatedAt?: string;
  source?: string;
  previousSnapshotId?: string;
};

type EventGraphUpdate =
  | {
      graphSource: "typescript";
      snapshotId: string;
      lastAnalyzedAt: string;
      message: string;
    }
  | {
      graphSource: GraphSource;
      snapshotId: string;
      message: string;
      lastAnalysisError: string;
    }
  | {
      graphSource: "replay";
      snapshotId: string;
      message: string;
    };

type LiveState = {
  ok: true;
  cwd: string;
  generatedAt: string;
  session: unknown;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
  events: SnitchEvent[];
  artifacts: {
    findings: string;
    nextAction: string;
    mermaid: string;
    prComment: string;
    handoff: string;
    timeline: string;
  };
  insights?: InsightArtifact;
  memory?: MemoryArtifact;
};

type SnitchStatusPayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  session: {
    runId: string;
    status: SnitchSession["status"];
    task: string;
    snapshotId: string;
    graphSource: GraphSource;
    analysisTarget: string;
    eventCount: number;
    lastEventAt: string;
    lastAnalyzedAt?: string;
    lastAnalysisError?: string;
  };
  counts: {
    events: number;
    nodes: number;
    edges: number;
    warnings: number;
    highWarnings: number;
    blockingWarnings: number;
  };
  warnings: Array<{
    id: string;
    severity: SnitchWarning["severity"];
    title: string;
    evidenceCount: number;
    repairCommand: string;
  }>;
  recentEvents: SnitchEvent[];
  artifacts: Record<
    | "graph"
    | "warnings"
    | "findings"
    | "nextAction"
    | "mermaid"
    | "handoff"
    | "prComment"
    | "timeline"
    | "insights"
    | "memory",
    {
      path: string;
      available: boolean;
      bytes: number;
    }
  >;
  integrations: {
    cerebras?: {
      status: IntegrationStatus;
      triageStatus: IntegrationStatus;
      model?: string;
    };
    backboard?: {
      status: IntegrationStatus;
      rules: string[];
    };
    memory?: {
      status: IntegrationStatus;
      rememberedWarnings: number;
    };
  };
  nextCommands: string[];
};

type SafeEventReference = {
  id: string;
  source: SnitchEvent["source"];
  phase: SnitchEvent["phase"];
  hook: string;
  receivedAt: string;
  safeSummary: SnitchEvent["safeSummary"];
  evidence?: SnitchEvent["evidence"];
};

type SnitchNextActionPayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  status: "clear" | "action_required";
  task: string;
  counts: {
    warnings: number;
    findings: number;
    anchoredFindings: number;
    relatedEvents: number;
  };
  topFinding?: SnitchFinding;
  latestEvent?: SafeEventReference;
  relatedEvents: SafeEventReference[];
  agentInstruction: string;
  nextCommands: string[];
};

type SnitchTracePayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  status: "clear" | "traced";
  task: string;
  warning: SnitchImpactPayload["warning"];
  finding?: SnitchFinding;
  relatedEvents: SafeEventReference[];
  timeline: TimelineEntry[];
  impact: {
    counts: SnitchImpactPayload["counts"];
    files: string[];
    nodes: SnitchImpactPayload["nodes"];
    edges: SnitchImpactPayload["edges"];
  };
  summary: string[];
  nextCommands: string[];
};

type ChangedFile = {
  path: string;
  status: string;
  oldPath?: string;
  targetPath?: string;
  inAnalysisTarget: boolean;
};

type ChangedFinding = {
  finding: SnitchFinding;
  matchedFiles: string[];
};

type SnitchChangedPayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  target: string;
  git: {
    available: boolean;
    error?: string;
  };
  changedFiles: ChangedFile[];
  changedFindings: ChangedFinding[];
  counts: {
    changedFiles: number;
    targetChangedFiles: number;
    activeFindings: number;
    changedFindings: number;
  };
  nextCommands: string[];
};

type DoctorStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  path?: string;
  nextCommand?: string;
};

type SnitchDoctorPayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  ready: boolean;
  summary: Record<DoctorStatus, number>;
  session?: {
    runId: string;
    status: SnitchSession["status"];
    task: string;
    analysisTarget: string;
    graphSource: GraphSource;
    eventCount: number;
  };
  config?: {
    agents: AgentTarget[];
    generatedConfigs: string[];
    hookAdapter: string;
    analysisTarget: string;
  };
  checks: DoctorCheck[];
  nextCommands: string[];
};

type SnitchImpactPayload = {
  ok: true;
  cwd: string;
  generatedAt: string;
  warning: {
    id: string;
    severity: SnitchWarning["severity"];
    title: string;
    message: string;
    evidence: string[];
    repairCommand: string;
  } | null;
  counts: {
    nodes: number;
    edges: number;
    files: number;
    warnings: number;
  };
  files: string[];
  nodes: Array<{
    id: string;
    kind: SnitchGraph["nodes"][number]["kind"];
    label: string;
    file?: string;
    line?: number;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    kind: SnitchGraph["edges"][number]["kind"];
    label?: string;
  }>;
  nextCommands: string[];
};

type InsightArtifact = {
  generatedAt: string;
  narration: string;
  cerebras: {
    status: IntegrationStatus;
    triageStatus: IntegrationStatus;
    model?: string;
  };
  backboard: {
    status: IntegrationStatus;
    rules: string[];
  };
  rankedWarnings: RankedWarning[];
};

type InsightOptions = {
  offline: boolean;
  now: Date;
};

type LiveServerOptions = {
  port: number;
  intervalMs: number;
  fileWatch: boolean;
  scanIntervalMs: number;
  target?: string;
};

type WatchRefreshResult = {
  status: "updated" | "kept-last-good";
  target: string;
  message: string;
};

type HookIngestResult = {
  ok: true;
  message: string;
  agentFeedback: string;
  nextAction: SnitchNextActionPayload;
};

type GitHubComment = {
  id: number;
  body?: string;
  html_url?: string;
};

type GitHookName = "post-commit" | "pre-push";

type GitHubPublishOptions = {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  apiUrl: string;
  commentPath: string;
  marker: string;
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

type McpToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type MemoryArtifact = {
  generatedAt: string;
  backboard: {
    status: IntegrationStatus;
    decision: "accepted";
    rememberedWarnings: number;
    warningIds: string[];
  };
};

type RepairPromptContext = {
  warning: SnitchWarning;
  task: string;
  target: string;
  ranking?: RankedWarning;
};

type CheckThreshold = SnitchWarning["severity"];

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
      const target = resolve(cwd, String(parsed.flags.get("target") ?? "."));
      const message = await initializeSnitch(cwd, task, now, agents, target);
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
      if (parsed.flags.has("json")) {
        return ok(`${JSON.stringify(await readSnitchStatusPayload(cwd), null, 2)}\n`);
      }

      return ok(await readSnitchStatus(cwd));
    }

    if (command === "doctor") {
      return ok(await readSnitchDoctor(cwd, parsed.flags));
    }

    if (command === "impact") {
      return ok(await readSnitchImpact(cwd, parsed.flags));
    }

    if (command === "trace") {
      return ok(await readSnitchTrace(cwd, parsed.flags));
    }

    if (command === "changed") {
      return ok(await readSnitchChanged(cwd, parsed.flags));
    }

    if (command === "findings") {
      return ok(await readSnitchFindings(cwd, parsed.flags));
    }

    if (command === "next-action") {
      return ok(await readSnitchNextAction(cwd, parsed.flags));
    }

    if (command === "mcp") {
      await startMcpStdioServer(cwd);
      return ok("");
    }

    if (command === "analyze") {
      const target = resolve(cwd, String(parsed.flags.get("target") ?? "."));
      const task = String(parsed.flags.get("task") ?? defaultTask);
      return ok(await analyzeTypeScriptRepo(cwd, target, task, now));
    }

    if (command === "check") {
      const target = resolve(cwd, String(parsed.flags.get("target") ?? "."));
      const task = String(parsed.flags.get("task") ?? defaultTask);
      return checkTypeScriptRepo(cwd, target, task, now, parsed.flags);
    }

    if (command === "watch") {
      const port = parsePort(parsed.flags.get("port"));
      const intervalMs = parseInterval(parsed.flags.get("interval"));
      const targetFlag = parsed.flags.get("target");
      const target = targetFlag && targetFlag !== true ? resolve(cwd, targetFlag) : undefined;
      const fileWatch = !parsed.flags.has("no-files");
      const scanIntervalMs = parseScanInterval(parsed.flags.get("scan-interval"));
      const liveOptions: LiveServerOptions = {
        port,
        intervalMs,
        fileWatch,
        scanIntervalMs
      };

      if (target) {
        liveOptions.target = target;
      }

      const url = await startLiveServer(cwd, liveOptions);
      return ok(
        [
          "Snitch live server started.",
          `- URL: ${url}`,
          "- State: /api/state",
          "- Events: GET /api/events",
          "- Hook ingest: POST /api/events?source=<agent>&hook=<hook>",
          `- File watcher: ${fileWatch ? `enabled (${scanIntervalMs}ms)` : "disabled"}`
        ].join("\n") + "\n"
      );
    }

    if (command === "insights") {
      return ok(
        await writeInsightArtifacts(cwd, {
          offline: parsed.flags.has("offline"),
          now
        })
      );
    }

    if (command === "repair-prompt") {
      return ok(await readRepairPrompt(cwd, parsed.flags));
    }

    if (command === "finalize") {
      const message = await finalizeSnitch(cwd, now);
      return ok(message);
    }

    if (command === "install-git-hooks") {
      const message = await installGitHooks(cwd, parsed.flags, now);
      return ok(message);
    }

    if (command === "publish-github") {
      const message = await publishGithubComment(cwd, parsed.flags, options.fetcher ?? fetch);
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
  await ensureDirs(cwd);

  const analysis = await writeTypeScriptArtifacts(cwd, {
    target,
    task,
    now,
    runId: `snitch-analyze-${basename(target) || "repo"}`
  });

  await persistAnalysisTarget(cwd, target, now, analysis.snapshot.id);

  return [
    `Snitch analyzed ${target}.`,
    `- Nodes: ${analysis.snapshot.graph.nodes.length}`,
    `- Edges: ${analysis.snapshot.graph.edges.length}`,
    `- Warnings: ${analysis.snapshot.warnings.length}`,
    "- Updated: .snitch/graph.json, .snitch/findings.json, .snitch/next-action.md, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function checkTypeScriptRepo(
  cwd: string,
  target: string,
  task: string,
  now: Date,
  flags: ParsedArgs["flags"]
): Promise<CliResult> {
  await ensureDirs(cwd);

  const failOn = parseCheckThreshold(flags.get("fail-on"));
  const analysis = await writeTypeScriptArtifacts(cwd, {
    target,
    task,
    now,
    runId: `snitch-check-${basename(target) || "repo"}`
  });
  const blockingWarnings = warningsAtOrAboveThreshold(analysis.snapshot.warnings, failOn);

  await persistAnalysisTarget(cwd, target, now, analysis.snapshot.id);

  if (flags.has("json")) {
    return {
      code: blockingWarnings.length > 0 ? 1 : 0,
      stdout: `${JSON.stringify(
        {
          ok: blockingWarnings.length === 0,
          target: analysis.target,
          failOn,
          counts: {
            nodes: analysis.snapshot.graph.nodes.length,
            edges: analysis.snapshot.graph.edges.length,
            warnings: analysis.snapshot.warnings.length,
            blockingWarnings: blockingWarnings.length
          },
          blockingWarnings: blockingWarnings.map((warning) => ({
            id: warning.id,
            severity: warning.severity,
            title: warning.title,
            repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
          }))
        },
        null,
        2
      )}\n`,
      stderr: ""
    };
  }

  const heading = blockingWarnings.length > 0 ? "Snitch check failed." : "Snitch check passed.";
  const warningLines = blockingWarnings.length > 0
    ? [
        "",
        "Blocking warnings:",
        ...blockingWarnings.map((warning) =>
          `- [${warning.severity}] ${warning.title} (${warning.id})\n  Repair: pnpm snitch repair-prompt --warning ${warning.id}`
        )
      ]
    : [];

  return {
    code: blockingWarnings.length > 0 ? 1 : 0,
    stdout: [
      heading,
      `- Target: ${analysis.target}`,
      `- Fail on: ${failOn}`,
      `- Nodes: ${analysis.snapshot.graph.nodes.length}`,
      `- Edges: ${analysis.snapshot.graph.edges.length}`,
      `- Warnings: ${analysis.snapshot.warnings.length}`,
      `- Blocking warnings: ${blockingWarnings.length}`,
      "- Updated: .snitch/graph.json, .snitch/warnings.json, .snitch/findings.json, .snitch/next-action.md, .snitch/pr-comment.md",
      ...warningLines
    ].join("\n") + "\n",
    stderr: ""
  };
}

async function initializeSnitch(
  cwd: string,
  task: string,
  now: Date,
  agents: AgentTarget[] = ["codex"],
  target: string = cwd
): Promise<string> {
  await ensureDirs(cwd);

  const createdAt = now.toISOString();
  const replay = getDemoReplay();
  const baseline = replay[0] ?? getReviewSnapshot(replay);
  const runId = createRunId(now);
  const generatedConfigs = generatedConfigPaths(agents);
  const storedTarget = storeTargetPath(cwd, target);
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
    analysis: {
      engine: "typescript",
      target: storedTarget,
      refreshOn: "file-event"
    },
    createdAt
  };
  const session = createSession({
    runId,
    task,
    status: "initialized",
    startedAt: createdAt,
    lastEventAt: createdAt,
    eventCount: 0,
    snapshotId: baseline.id,
    graphSource: "replay",
    analysisTarget: storedTarget
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
    `- Analysis target: ${storedTarget}`,
    "- Local state: .snitch/config.json, .snitch/session.json, .snitch/events.jsonl",
    "- Artifacts: .snitch/graph.json, .snitch/findings.json, .snitch/next-action.md, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function recordSnitchEvent(
  cwd: string,
  input: { source: string; hook: string; stdin: string; now: Date }
): Promise<string> {
  await ensureInitialized(cwd, input.now);

  const session = await readSession(cwd);
  const events = await readEvents(cwd);
  const config = await readConfig(cwd);
  const event = normalizeSnitchEvent({
    runId: session.runId,
    source: input.source,
    hook: input.hook,
    stdin: input.stdin,
    receivedAt: input.now
  });
  const nextEvents = [...events, event];
  const graphUpdate = await updateGraphForEvent(cwd, {
    event,
    eventCount: nextEvents.length,
    session,
    config,
    now: input.now
  });
  const updatedSession: SnitchSession = {
    ...session,
    status: "running",
    lastEventAt: input.now.toISOString(),
    eventCount: nextEvents.length,
    snapshotId: graphUpdate.snapshotId,
    graphSource: graphUpdate.graphSource
  } satisfies SnitchSession;

  if (graphUpdate.graphSource === "typescript" && "lastAnalyzedAt" in graphUpdate) {
    updatedSession.lastAnalyzedAt = graphUpdate.lastAnalyzedAt;
    delete updatedSession.lastAnalysisError;
  } else if ("lastAnalysisError" in graphUpdate) {
    updatedSession.lastAnalysisError = graphUpdate.lastAnalysisError;
  }

  await writeJsonl(cwd, eventsFile, nextEvents);
  await writeJson(cwd, ".snitch/session.json", updatedSession);
  const nextAction = await readSnitchNextActionPayload(cwd);
  const agentFeedback = formatSnitchNextAction(nextAction);
  await writeText(cwd, ".snitch/next-action.md", agentFeedback);

  return [
    `Snitch captured ${input.source}:${input.hook}.`,
    `- Events: ${nextEvents.length}`,
    `- Graph: ${graphUpdate.message}`,
    `- Next action: ${formatNextActionSummary(nextAction)}`,
    "- Updated: .snitch/graph.json, .snitch/findings.json, .snitch/next-action.md, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
}

async function finalizeSnitch(cwd: string, now: Date): Promise<string> {
  await ensureInitialized(cwd, now);

  const session = await readSession(cwd);
  const config = await readConfig(cwd);
  const target = resolveStoredTarget(cwd, session.analysisTarget ?? config.analysis.target);

  if (session.graphSource === "typescript") {
    const analysis = await writeTypeScriptArtifacts(cwd, {
      target,
      task: session.task,
      now,
      runId: session.runId
    });

    const updatedSession: SnitchSession = {
      ...session,
      status: "finalized",
      lastEventAt: now.toISOString(),
      snapshotId: analysis.snapshot.id,
      graphSource: "typescript",
      lastAnalyzedAt: analysis.analyzedAt
    };

    delete updatedSession.lastAnalysisError;
    await writeJson(cwd, ".snitch/session.json", updatedSession);
    const memory = await rememberWarningsOnFinalize(cwd, now);

    return [
      "Snitch finalized the background session.",
      "- Graph: refreshed from TypeScript target",
      formatMemoryStatus(memory),
      "- PR body: .snitch/pr-comment.md",
      "- Handoff: .snitch/handoff.md",
      "- Mermaid: .snitch/mermaid.mmd"
    ].join("\n") + "\n";
  }

  const replay = getDemoReplay();
  const reviewSnapshot = getReviewSnapshot(replay);
  const updatedSession: SnitchSession = {
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
  const memory = await rememberWarningsOnFinalize(cwd, now);

  return [
    "Snitch finalized the background session.",
    formatMemoryStatus(memory),
    "- PR body: .snitch/pr-comment.md",
    "- Handoff: .snitch/handoff.md",
    "- Mermaid: .snitch/mermaid.mmd"
  ].join("\n") + "\n";
}

async function installGitHooks(cwd: string, flags: ParsedArgs["flags"], now: Date): Promise<string> {
  await ensureInitialized(cwd, now);

  const hooksDir = await resolveGitHooksDir(cwd);
  const force = flags.has("force");
  const hookNames: GitHookName[] = ["post-commit", "pre-push"];
  const installed: string[] = [];

  await mkdir(hooksDir, { recursive: true });

  const plans = await Promise.all(
    hookNames.map(async (hookName) => {
      const hookPath = resolve(hooksDir, hookName);
      const current = await readAbsoluteTextIfExists(hookPath);

      return { hookName, hookPath, current };
    })
  );

  for (const plan of plans) {
    if (plan.current && !isSnitchManagedHook(plan.current) && !force) {
      throw new Error(
        `Refusing to overwrite existing Git hook ${plan.hookPath}. Re-run with --force after reviewing it.`
      );
    }
  }

  for (const plan of plans) {
    await writeFile(plan.hookPath, createGitHookScript(plan.hookName), "utf8");
    await chmod(plan.hookPath, 0o755);
    installed.push(plan.hookPath);
  }

  return [
    "Snitch Git hooks installed.",
    ...installed.map((path) => `- ${path}`),
    "- Hooks refresh local .snitch artifacts only; GitHub publishing stays in Actions or explicit publish-github."
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
    `- Graph source: ${session.graphSource ?? "replay"}`,
    `- Analysis target: ${session.analysisTarget ?? "."}`,
    `- Hook adapter: ${hookFile}`,
    "- Configure your coding agent to run: node .snitch/hooks/codex-hook.mjs <hook-name>"
  ].join("\n") + "\n";
}

async function readSnitchStatusPayload(cwd: string): Promise<SnitchStatusPayload> {
  const session = await readSession(cwd);
  const events = await readEvents(cwd);
  const graph = (await readGraphIfExists(cwd)) ?? {
    id: session.snapshotId,
    title: "No graph available",
    nodes: [],
    edges: []
  };
  const warnings = await readWarnings(cwd, graph);
  const sortedWarnings = warningsAtOrAboveThreshold(warnings, "info");
  const highWarnings = warnings.filter((warning) => warning.severity === "high");
  const blockingWarnings = warningsAtOrAboveThreshold(warnings, "medium");
  const insightsText = await readTextIfExists(cwd, ".snitch/insights.json");
  const memoryText = await readTextIfExists(cwd, ".snitch/memory.json");
  const integrations = readStatusIntegrations(insightsText, memoryText);
  const lastEventAt = events.at(-1)?.receivedAt ?? session.lastEventAt;

  return {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    session: {
      runId: session.runId,
      status: session.status,
      task: session.task,
      snapshotId: session.snapshotId,
      graphSource: session.graphSource,
      analysisTarget: session.analysisTarget,
      eventCount: events.length,
      lastEventAt,
      ...(session.lastAnalyzedAt ? { lastAnalyzedAt: session.lastAnalyzedAt } : {}),
      ...(session.lastAnalysisError ? { lastAnalysisError: session.lastAnalysisError } : {})
    },
    counts: {
      events: events.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      warnings: warnings.length,
      highWarnings: highWarnings.length,
      blockingWarnings: blockingWarnings.length
    },
    warnings: sortedWarnings.map((warning) => ({
      id: warning.id,
      severity: warning.severity,
      title: warning.title,
      evidenceCount: warning.evidence.length,
      repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
    })),
    recentEvents: events.slice(-20),
    artifacts: await readStatusArtifacts(cwd),
    integrations,
    nextCommands: createStatusNextCommands(session, sortedWarnings)
  };
}

async function readStatusArtifacts(cwd: string): Promise<SnitchStatusPayload["artifacts"]> {
  const artifactPaths = {
    graph: ".snitch/graph.json",
    warnings: ".snitch/warnings.json",
    findings: ".snitch/findings.json",
    nextAction: ".snitch/next-action.md",
    mermaid: ".snitch/mermaid.mmd",
    handoff: ".snitch/handoff.md",
    prComment: ".snitch/pr-comment.md",
    timeline: ".snitch/timeline.jsonl",
    insights: ".snitch/insights.json",
    memory: ".snitch/memory.json"
  } as const;

  const entries = await Promise.all(
    Object.entries(artifactPaths).map(async ([key, path]) => {
      const contents = await readTextIfExists(cwd, path);

      return [
        key,
        {
          path,
          available: contents.length > 0,
          bytes: Buffer.byteLength(contents)
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries) as SnitchStatusPayload["artifacts"];
}

function readStatusIntegrations(
  insightsText: string,
  memoryText: string
): SnitchStatusPayload["integrations"] {
  const integrations: SnitchStatusPayload["integrations"] = {};

  if (insightsText.trim()) {
    const insights = JSON.parse(insightsText) as Partial<InsightArtifact>;

    if (insights.cerebras) {
      integrations.cerebras = {
        status: insights.cerebras.status,
        triageStatus: insights.cerebras.triageStatus,
        ...(insights.cerebras.model ? { model: insights.cerebras.model } : {})
      };
    }

    if (insights.backboard) {
      integrations.backboard = {
        status: insights.backboard.status,
        rules: insights.backboard.rules ?? []
      };
    }
  }

  if (memoryText.trim()) {
    const memory = JSON.parse(memoryText) as Partial<MemoryArtifact>;

    if (memory.backboard) {
      integrations.memory = {
        status: memory.backboard.status,
        rememberedWarnings: memory.backboard.rememberedWarnings ?? 0
      };
    }
  }

  return integrations;
}

function createStatusNextCommands(
  session: SnitchSession,
  warnings: SnitchWarning[]
): string[] {
  const commands = [
    "pnpm snitch doctor --json",
    "pnpm snitch changed --json",
    "pnpm snitch next-action --json",
    `pnpm snitch check --target ${shellArgForPrompt(session.analysisTarget)} --fail-on medium --json`
  ];
  const firstWarning = warnings[0];

  if (firstWarning) {
    commands.push(`pnpm snitch trace --warning ${firstWarning.id} --json`);
    commands.push(`pnpm snitch repair-prompt --warning ${firstWarning.id}`);
  }

  commands.push("pnpm snitch finalize");

  return commands;
}

async function readSnitchDoctor(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const payload = await readSnitchDoctorPayload(cwd);

  if (flags.has("json")) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  return formatSnitchDoctor(payload);
}

async function readSnitchDoctorPayload(cwd: string): Promise<SnitchDoctorPayload> {
  const [session, config] = await Promise.all([readSessionIfExists(cwd), readConfigIfExists(cwd)]);
  const checks: DoctorCheck[] = [];
  const target = session?.analysisTarget ?? config?.analysis.target ?? ".";
  const resolvedTarget = resolveStoredTarget(cwd, target);
  const initCommand = createDoctorInitCommand(target);

  checks.push(session
    ? doctorCheck({
        id: "session",
        label: "Session state",
        status: "pass",
        detail: `${session.status}, ${session.eventCount} captured event(s), graph source ${session.graphSource}`,
        path: ".snitch/session.json"
      })
    : doctorCheck({
        id: "session",
        label: "Session state",
        status: "fail",
        detail: "No .snitch/session.json found.",
        path: ".snitch/session.json",
        nextCommand: initCommand
      }));

  checks.push(config
    ? doctorCheck({
        id: "config",
        label: "Local config",
        status: "pass",
        detail: `agents=${config.agents.join(",") || "none"}, target=${config.analysis.target}`,
        path: ".snitch/config.json"
      })
    : doctorCheck({
        id: "config",
        label: "Local config",
        status: "fail",
        detail: "No .snitch/config.json found.",
        path: ".snitch/config.json",
        nextCommand: initCommand
      }));

  checks.push(await readTargetDoctorCheck(cwd, target, resolvedTarget));
  checks.push(await readHookAdapterDoctorCheck(cwd, config, initCommand));
  checks.push(await readAgentConfigsDoctorCheck(cwd, config, initCommand));
  checks.push(await readEventLogDoctorCheck(cwd, session));
  checks.push(await readArtifactDoctorCheck(cwd, target));
  checks.push(await readGraphDoctorCheck(cwd, target));
  checks.push(...await readGitHookDoctorChecks(cwd));
  checks.push(await readProviderDoctorCheck(cwd));
  checks.push(doctorCheck({
    id: "mcp",
    label: "MCP server",
    status: "pass",
    detail: "Agents can launch Snitch through `pnpm --silent snitch mcp` and call snitch_doctor.",
    nextCommand: "pnpm --silent snitch mcp"
  }));

  const summary = summarizeDoctorChecks(checks);

  return {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    ready: summary.fail === 0,
    summary,
    ...(session
      ? {
          session: {
            runId: session.runId,
            status: session.status,
            task: session.task,
            analysisTarget: session.analysisTarget,
            graphSource: session.graphSource,
            eventCount: session.eventCount
          }
        }
      : {}),
    ...(config
      ? {
          config: {
            agents: config.agents,
            generatedConfigs: config.generatedConfigs,
            hookAdapter: config.hookAdapter,
            analysisTarget: config.analysis.target
          }
        }
      : {}),
    checks,
    nextCommands: createDoctorNextCommands(checks, target)
  };
}

async function readTargetDoctorCheck(
  cwd: string,
  target: string,
  resolvedTarget: string
): Promise<DoctorCheck> {
  if (await pathExists(resolvedTarget)) {
    return doctorCheck({
      id: "analysis-target",
      label: "Analysis target",
      status: "pass",
      detail: `Target resolves to ${storeTargetPath(cwd, resolvedTarget)}.`,
      path: target
    });
  }

  return doctorCheck({
    id: "analysis-target",
    label: "Analysis target",
    status: "fail",
    detail: `Configured target does not exist: ${target}.`,
    path: target,
    nextCommand: createDoctorInitCommand(".")
  });
}

async function readHookAdapterDoctorCheck(
  cwd: string,
  config: SnitchConfig | undefined,
  initCommand: string
): Promise<DoctorCheck> {
  const hookPath = config?.hookAdapter ?? hookFile;
  const hook = await inspectFile(cwd, hookPath);

  if (!hook.exists) {
    return doctorCheck({
      id: "hook-adapter",
      label: "Hook adapter",
      status: "fail",
      detail: "Generated hook adapter is missing.",
      path: hookPath,
      nextCommand: initCommand
    });
  }

  if (!hook.executable) {
    return doctorCheck({
      id: "hook-adapter",
      label: "Hook adapter",
      status: "warn",
      detail: "Generated hook adapter exists but is not executable.",
      path: hookPath,
      nextCommand: `chmod +x ${shellArgForPrompt(hookPath)}`
    });
  }

  return doctorCheck({
    id: "hook-adapter",
    label: "Hook adapter",
    status: "pass",
    detail: `Executable adapter is ready (${hook.bytes} bytes).`,
    path: hookPath
  });
}

async function readAgentConfigsDoctorCheck(
  cwd: string,
  config: SnitchConfig | undefined,
  initCommand: string
): Promise<DoctorCheck> {
  if (!config) {
    return doctorCheck({
      id: "agent-configs",
      label: "Agent configs",
      status: "fail",
      detail: "Cannot inspect generated agent configs until Snitch is initialized.",
      nextCommand: initCommand
    });
  }

  if (config.generatedConfigs.length === 0) {
    return doctorCheck({
      id: "agent-configs",
      label: "Agent configs",
      status: "warn",
      detail: "No generated Codex, Cursor, Claude Code, or OpenCode config is recorded.",
      nextCommand: initCommand
    });
  }

  const missing: string[] = [];

  for (const configPath of config.generatedConfigs) {
    const file = await inspectFile(cwd, configPath);

    if (!file.exists) {
      missing.push(configPath);
    }
  }

  if (missing.length > 0) {
    return doctorCheck({
      id: "agent-configs",
      label: "Agent configs",
      status: "warn",
      detail: `Missing generated config(s): ${missing.join(", ")}.`,
      nextCommand: initCommand
    });
  }

  return doctorCheck({
    id: "agent-configs",
    label: "Agent configs",
    status: "pass",
    detail: `Generated configs present: ${config.generatedConfigs.join(", ")}.`
  });
}

async function readEventLogDoctorCheck(
  cwd: string,
  session: SnitchSession | undefined
): Promise<DoctorCheck> {
  const log = await inspectFile(cwd, eventsFile);

  if (!log.exists) {
    return doctorCheck({
      id: "event-log",
      label: "Safe event log",
      status: "warn",
      detail: "No safe hook event log found yet.",
      path: eventsFile,
      nextCommand: "pnpm snitch event --source codex --hook PostToolUse"
    });
  }

  return doctorCheck({
    id: "event-log",
    label: "Safe event log",
    status: "pass",
    detail: `${session?.eventCount ?? 0} captured event(s); raw hook payloads are not stored.`,
    path: eventsFile
  });
}

async function readArtifactDoctorCheck(cwd: string, target: string): Promise<DoctorCheck> {
  const artifacts = await readStatusArtifacts(cwd);
  const requiredArtifacts = [
    "graph",
    "warnings",
    "findings",
    "nextAction",
    "mermaid",
    "handoff",
    "prComment"
  ] as const;
  const missing = requiredArtifacts.filter((name) => !artifacts[name].available);

  if (missing.length > 0) {
    return doctorCheck({
      id: "artifacts",
      label: "Generated artifacts",
      status: "fail",
      detail: `Missing artifact(s): ${missing.map((name) => artifacts[name].path).join(", ")}.`,
      nextCommand: `pnpm snitch analyze --target ${shellArgForPrompt(target)} --task "<current task>"`
    });
  }

  const totalBytes = requiredArtifacts.reduce((sum, name) => sum + artifacts[name].bytes, 0);

  return doctorCheck({
    id: "artifacts",
    label: "Generated artifacts",
    status: "pass",
    detail: `Graph, findings, next action, Mermaid, handoff, and PR comment are present (${totalBytes} bytes).`
  });
}

async function readGraphDoctorCheck(cwd: string, target: string): Promise<DoctorCheck> {
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    return doctorCheck({
      id: "graph",
      label: "Graph parse",
      status: "fail",
      detail: "No readable .snitch/graph.json is available.",
      path: ".snitch/graph.json",
      nextCommand: `pnpm snitch analyze --target ${shellArgForPrompt(target)} --task "<current task>"`
    });
  }

  try {
    const warnings = await readWarnings(cwd, graph);

    return doctorCheck({
      id: "graph",
      label: "Graph parse",
      status: graph.nodes.length > 0 ? "pass" : "warn",
      detail: `${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ${warnings.length} warning(s).`,
      path: ".snitch/graph.json"
    });
  } catch (error) {
    return doctorCheck({
      id: "graph",
      label: "Graph parse",
      status: "fail",
      detail: `Graph exists, but warning parsing failed: ${errorMessage(error)}.`,
      path: ".snitch/graph.json",
      nextCommand: `pnpm snitch analyze --target ${shellArgForPrompt(target)} --task "<current task>"`
    });
  }
}

async function readGitHookDoctorChecks(cwd: string): Promise<DoctorCheck[]> {
  let hooksDir: string;

  try {
    hooksDir = await resolveGitHooksDir(cwd);
  } catch {
    return [
      doctorCheck({
        id: "git-hooks",
        label: "Local Git hooks",
        status: "warn",
        detail: "No Git hooks directory was found; local commit/push refresh is not installed.",
        nextCommand: "pnpm snitch install-git-hooks"
      })
    ];
  }

  const hookNames: GitHookName[] = ["post-commit", "pre-push"];
  const states = await Promise.all(
    hookNames.map(async (hookName) => {
      const hookPath = resolve(hooksDir, hookName);
      const file = await inspectAbsoluteFile(hookPath);
      const contents = file.exists ? await readAbsoluteTextIfExists(hookPath) : "";

      return {
        hookName,
        path: hookPath,
        exists: file.exists,
        managed: contents ? isSnitchManagedHook(contents) : false
      };
    })
  );
  const missing = states.filter((state) => !state.exists).map((state) => state.hookName);
  const unmanaged = states
    .filter((state) => state.exists && !state.managed)
    .map((state) => state.hookName);

  if (missing.length === 0 && unmanaged.length === 0) {
    return [
      doctorCheck({
        id: "git-hooks",
        label: "Local Git hooks",
        status: "pass",
        detail: "Snitch-managed post-commit and pre-push hooks are installed.",
        path: storeTargetPath(cwd, hooksDir)
      })
    ];
  }

  return [
    doctorCheck({
      id: "git-hooks",
      label: "Local Git hooks",
      status: "warn",
      detail: [
        missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
        unmanaged.length > 0 ? `unmanaged: ${unmanaged.join(", ")}` : ""
      ].filter(Boolean).join("; "),
      path: storeTargetPath(cwd, hooksDir),
      nextCommand: unmanaged.length > 0
        ? "pnpm snitch install-git-hooks --force"
        : "pnpm snitch install-git-hooks"
    })
  ];
}

async function readProviderDoctorCheck(cwd: string): Promise<DoctorCheck> {
  const env = await loadRuntimeEnv(cwd);
  const cerebras = env.CEREBRAS_API_KEY ? "configured" : "not configured";
  const backboard = env.BACKBOARD_API_KEY ? "configured" : "not configured";

  return doctorCheck({
    id: "providers",
    label: "Optional providers",
    status: "pass",
    detail: `Cerebras ${cerebras}; Backboard ${backboard}. Provider keys are optional and are never written to artifacts.`
  });
}

function formatSnitchDoctor(payload: SnitchDoctorPayload): string {
  return [
    "Snitch doctor",
    `- Ready: ${payload.ready ? "yes" : "no"}`,
    `- Checks: ${payload.summary.pass} pass, ${payload.summary.warn} warn, ${payload.summary.fail} fail`,
    ...(payload.session
      ? [
          `- Session: ${payload.session.status}, ${payload.session.graphSource}, ${payload.session.eventCount} event(s)`,
          `- Target: ${payload.session.analysisTarget}`
        ]
      : []),
    "",
    "Checks:",
    ...payload.checks.map(formatDoctorCheck),
    "",
    "Next commands:",
    ...payload.nextCommands.map((command) => `- ${command}`)
  ].join("\n") + "\n";
}

function formatDoctorCheck(check: DoctorCheck): string {
  const path = check.path ? ` (${check.path})` : "";
  const next = check.nextCommand ? `\n  Next: ${check.nextCommand}` : "";

  return `- [${check.status}] ${check.label}: ${check.detail}${path}${next}`;
}

function createDoctorNextCommands(checks: DoctorCheck[], target: string): string[] {
  const commands = checks
    .map((check) => check.nextCommand)
    .filter((command): command is string => Boolean(command));

  commands.push(
    "pnpm snitch status --json",
    "pnpm snitch changed --json",
    "pnpm snitch next-action --json",
    `pnpm snitch check --target ${shellArgForPrompt(target)} --fail-on medium --json`
  );

  return unique(commands);
}

function createDoctorInitCommand(target: string): string {
  return `pnpm snitch init --agent all --target ${shellArgForPrompt(target)} --task "<current task>"`;
}

function summarizeDoctorChecks(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
}

function doctorCheck(check: DoctorCheck): DoctorCheck {
  return check;
}

async function inspectFile(
  cwd: string,
  path: string
): Promise<{ exists: boolean; bytes: number; executable: boolean }> {
  return inspectAbsoluteFile(resolve(cwd, path));
}

async function inspectAbsoluteFile(
  path: string
): Promise<{ exists: boolean; bytes: number; executable: boolean }> {
  try {
    const stats = await stat(path);

    return {
      exists: stats.isFile(),
      bytes: stats.isFile() ? stats.size : 0,
      executable: Boolean(stats.mode & 0o111)
    };
  } catch {
    return {
      exists: false,
      bytes: 0,
      executable: false
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readSnitchImpact(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const payload = await readSnitchImpactPayload(cwd, flags);

  if (flags.has("json")) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  return formatSnitchImpact(payload);
}

async function readSnitchImpactPayload(
  cwd: string,
  flags: ParsedArgs["flags"]
): Promise<SnitchImpactPayload> {
  const session = await readSession(cwd);
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    throw new Error("No Snitch graph found. Run `pnpm snitch analyze` or `pnpm snitch init` first.");
  }

  const warnings = warningsAtOrAboveThreshold(await readWarnings(cwd, graph), "info");
  const requestedWarningFlag = flags.get("warning");
  const requestedWarningId =
    requestedWarningFlag && requestedWarningFlag !== true ? requestedWarningFlag : undefined;
  const warning = selectImpactWarning(warnings, requestedWarningId);
  const scopedGraph = warning
    ? scopeGraph(graph, diffGraph(graph, graph), "impacted", warning.id)
    : graph;
  const files = unique(
    scopedGraph.nodes
      .map((node) => node.file)
      .filter((file): file is string => typeof file === "string" && file.length > 0)
      .sort()
  );
  const warningNodeCount = scopedGraph.nodes.filter((node) => node.kind === "warning").length;

  return {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    warning: warning
      ? {
          id: warning.id,
          severity: warning.severity,
          title: warning.title,
          message: warning.message,
          evidence: warning.evidence,
          repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
        }
      : null,
    counts: {
      nodes: scopedGraph.nodes.length,
      edges: scopedGraph.edges.length,
      files: files.length,
      warnings: warningNodeCount
    },
    files,
    nodes: scopedGraph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.file ? { file: node.file } : {}),
      ...(typeof node.line === "number" ? { line: node.line } : {})
    })),
    edges: scopedGraph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label ? { label: edge.label } : {})
    })),
    nextCommands: createImpactNextCommands(session, warning)
  };
}

function selectImpactWarning(
  warnings: SnitchWarning[],
  requestedWarningId: string | undefined
): SnitchWarning | undefined {
  if (requestedWarningId) {
    const warning = warnings.find((item) => item.id === requestedWarningId);

    if (!warning) {
      throw new Error(`No active Snitch warning matches ${requestedWarningId}.`);
    }

    return warning;
  }

  return warnings[0];
}

function createImpactNextCommands(
  session: SnitchSession,
  warning: SnitchWarning | undefined
): string[] {
  const commands: string[] = [];

  if (warning) {
    commands.push(`pnpm snitch repair-prompt --warning ${warning.id}`);
  }

  commands.push(
    `pnpm snitch check --target ${shellArgForPrompt(session.analysisTarget)} --fail-on medium --json`,
    "pnpm snitch status --json"
  );

  return commands;
}

function formatSnitchImpact(payload: SnitchImpactPayload): string {
  const warningLines = payload.warning
    ? [
        `- Warning: [${payload.warning.severity}] ${payload.warning.title}`,
        `- Warning ID: ${payload.warning.id}`,
        `- Repair: ${payload.warning.repairCommand}`
      ]
    : ["- No active warnings; showing the full graph scope."];
  const fileLines = payload.files.length > 0
    ? payload.files.map((file) => `  - ${file}`)
    : ["  - none"];
  const nodeLines = payload.nodes
    .slice(0, 12)
    .map((node) => `  - ${node.kind}: ${node.label} (${node.id})${formatNodeLocation(node)}`);
  const edgeLines = payload.edges
    .slice(0, 12)
    .map((edge) => `  - ${edge.kind}: ${edge.from} -> ${edge.to}`);

  return [
    "Snitch impact",
    ...warningLines,
    `- Scope: ${payload.counts.nodes} nodes, ${payload.counts.edges} edges, ${payload.counts.files} files`,
    "",
    "Affected files:",
    ...fileLines,
    "",
    "Nodes:",
    ...(nodeLines.length > 0 ? nodeLines : ["  - none"]),
    ...(payload.nodes.length > nodeLines.length
      ? [`  - ${payload.nodes.length - nodeLines.length} more nodes in --json output`]
      : []),
    "",
    "Edges:",
    ...(edgeLines.length > 0 ? edgeLines : ["  - none"]),
    ...(payload.edges.length > edgeLines.length
      ? [`  - ${payload.edges.length - edgeLines.length} more edges in --json output`]
      : []),
    "",
    "Next commands:",
    ...payload.nextCommands.map((command) => `- ${command}`)
  ].join("\n") + "\n";
}

function formatNodeLocation(node: SnitchImpactPayload["nodes"][number]): string {
  if (!node.file) {
    return "";
  }

  return typeof node.line === "number" ? ` at ${node.file}:${node.line}` : ` at ${node.file}`;
}

async function readSnitchTrace(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const payload = await readSnitchTracePayload(cwd, flags);

  if (flags.has("json")) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  return formatSnitchTrace(payload);
}

async function readSnitchTracePayload(
  cwd: string,
  flags: ParsedArgs["flags"]
): Promise<SnitchTracePayload> {
  const session = await readSession(cwd);
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    throw new Error("No Snitch graph found. Run `pnpm snitch analyze` or `pnpm snitch init` first.");
  }

  const warnings = warningsAtOrAboveThreshold(await readWarnings(cwd, graph), "info");
  const requestedWarningFlag = flags.get("warning");
  const requestedWarningId =
    requestedWarningFlag && requestedWarningFlag !== true ? requestedWarningFlag : undefined;
  const warning = selectImpactWarning(warnings, requestedWarningId);
  const findings = buildSnitchFindings(graph, warnings);
  const finding = warning
    ? findings.find((item) => item.warningId === warning.id)
    : undefined;
  const scopedGraph = warning
    ? scopeGraph(graph, diffGraph(graph, graph), "impacted", warning.id)
    : graph;
  const files = unique(
    scopedGraph.nodes
      .map((node) => node.file)
      .filter((file): file is string => typeof file === "string" && file.length > 0)
      .sort()
  );
  const nodes = scopedGraph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.file ? { file: node.file } : {}),
    ...(typeof node.line === "number" ? { line: node.line } : {})
  }));
  const edges = scopedGraph.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    ...(edge.label ? { label: edge.label } : {})
  }));
  const warningPayload = warning
    ? {
        id: warning.id,
        severity: warning.severity,
        title: warning.title,
        message: warning.message,
        evidence: warning.evidence,
        repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
      }
    : null;
  const events = await readEvents(cwd);
  const relatedEvents = finding
    ? events.filter((event) => eventTouchesFinding(event, finding)).slice(-8).map(toSafeEventReference)
    : [];
  const timeline = (await readTimelineEntries(cwd)).slice(-8);
  const nextCommands = warning
    ? [
        `pnpm snitch repair-prompt --warning ${warning.id}`,
        `pnpm snitch impact --warning ${warning.id} --json`,
        "pnpm snitch next-action --json",
        `pnpm snitch check --target ${shellArgForPrompt(session.analysisTarget)} --fail-on medium --json`
      ]
    : [
        `pnpm snitch check --target ${shellArgForPrompt(session.analysisTarget)} --fail-on medium --json`,
        "pnpm snitch finalize"
      ];
  const payload: SnitchTracePayload = {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    status: warning ? "traced" : "clear",
    task: session.task,
    warning: warningPayload,
    relatedEvents,
    timeline,
    impact: {
      counts: {
        nodes: scopedGraph.nodes.length,
        edges: scopedGraph.edges.length,
        files: files.length,
        warnings: scopedGraph.nodes.filter((node) => node.kind === "warning").length
      },
      files,
      nodes,
      edges
    },
    summary: createTraceSummary({
      warning,
      finding,
      relatedEvents,
      timeline,
      files
    }),
    nextCommands
  };

  if (finding) {
    payload.finding = finding;
  }

  return payload;
}

function formatSnitchTrace(payload: SnitchTracePayload): string {
  const warningLines = payload.warning
    ? [
        `- Warning: [${payload.warning.severity}] ${payload.warning.title}`,
        `- Warning ID: ${payload.warning.id}`,
        `- Anchor: ${payload.finding ? formatFindingLocation(payload.finding) : "unanchored"}`,
        `- Repair: ${payload.warning.repairCommand}`
      ]
    : ["- No active warnings to trace."];
  const eventLines = payload.relatedEvents.length > 0
    ? payload.relatedEvents.map((event) => `  - ${event.source}:${event.hook} ${formatSafeEventSummary(event)}`)
    : ["  - none"];
  const timelineLines = payload.timeline.length > 0
    ? payload.timeline.map((entry) => `  - ${formatTimelineEntry(entry)}`)
    : ["  - none"];
  const fileLines = payload.impact.files.length > 0
    ? payload.impact.files.map((file) => `  - ${file}`)
    : ["  - none"];

  return [
    "Snitch warning trace",
    ...warningLines,
    `- Scope: ${payload.impact.counts.nodes} nodes, ${payload.impact.counts.edges} edges`,
    "",
    "Trace summary:",
    ...payload.summary.map((line) => `- ${line}`),
    "",
    "Likely related agent events:",
    ...eventLines,
    "",
    "Graph timeline:",
    ...timelineLines,
    "",
    "Affected files:",
    ...fileLines,
    "",
    "Next commands:",
    ...payload.nextCommands.map((command) => `- ${command}`)
  ].join("\n") + "\n";
}

function createTraceSummary(input: {
  warning: SnitchWarning | undefined;
  finding: SnitchFinding | undefined;
  relatedEvents: SafeEventReference[];
  timeline: TimelineEntry[];
  files: string[];
}): string[] {
  if (!input.warning) {
    return ["No active warning is present in the current graph."];
  }

  return [
    `${input.warning.title} is active in the current code-derived graph.`,
    input.finding
      ? `Snitch anchors the finding at ${formatFindingLocation(input.finding)}.`
      : "Snitch could not anchor this warning to a file yet.",
    input.relatedEvents.length > 0
      ? `${input.relatedEvents.length} safe hook event(s) touched the anchored file.`
      : "No safe hook event touched the anchored file in the retained event window.",
    input.timeline.length > 0
      ? `${input.timeline.length} recent graph timeline ${input.timeline.length === 1 ? "entry is" : "entries are"} available for replay.`
      : "No graph timeline entries are available yet.",
    input.files.length > 0
      ? `Impacted file set: ${input.files.join(", ")}.`
      : "No impacted files were found in the scoped graph."
  ];
}

function formatTimelineEntry(entry: TimelineEntry): string {
  const diff = entry.diffSummary;
  const parts = [
    `${entry.title} (${entry.snapshotId})`,
    `warnings=${entry.warningCount}`,
    `nodes +${diff.addedNodes}/-${diff.removedNodes}`,
    `edges +${diff.addedEdges}/-${diff.removedEdges}`
  ];

  if (entry.source) {
    parts.push(`source=${entry.source}`);
  }

  return parts.join(", ");
}

async function readSnitchChanged(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const payload = await readSnitchChangedPayload(cwd, flags);

  if (flags.has("json")) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  return formatSnitchChanged(payload);
}

async function readSnitchChangedPayload(
  cwd: string,
  flags: ParsedArgs["flags"]
): Promise<SnitchChangedPayload> {
  const session = await readSession(cwd);
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    throw new Error("No Snitch graph found. Run `pnpm snitch analyze` or `pnpm snitch init` first.");
  }

  const targetFlag = flags.get("target");
  const target = resolveStoredTarget(
    cwd,
    targetFlag && targetFlag !== true ? targetFlag : session.analysisTarget
  );
  const gitChanged = await readGitChangedFiles(cwd);
  const changedFiles = gitChanged.files.map((file) => withTargetPath(cwd, target, file));
  const warnings = await readWarnings(cwd, graph);
  const findings = buildSnitchFindings(graph, warnings);
  const changedFindings = findings
    .map((finding) => matchFindingToChangedFiles(finding, graph, changedFiles))
    .filter((match): match is ChangedFinding => Boolean(match));
  const targetChangedFiles = changedFiles.filter((file) => file.inAnalysisTarget).length;

  return {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    target: storeTargetPath(cwd, target),
    git: {
      available: gitChanged.available,
      ...(gitChanged.error ? { error: gitChanged.error } : {})
    },
    changedFiles,
    changedFindings,
    counts: {
      changedFiles: changedFiles.length,
      targetChangedFiles,
      activeFindings: findings.length,
      changedFindings: changedFindings.length
    },
    nextCommands: createChangedNextCommands(session, changedFindings)
  };
}

function formatSnitchChanged(payload: SnitchChangedPayload): string {
  const changedFileLines = payload.changedFiles.length > 0
    ? payload.changedFiles.map((file) => `  - ${file.status} ${file.path}${file.targetPath ? ` -> ${file.targetPath}` : ""}`)
    : ["  - none"];
  const findingLines = payload.changedFindings.length > 0
    ? payload.changedFindings.flatMap(({ finding, matchedFiles }) => [
        `- [${finding.severity}] ${finding.title} (${formatFindingLocation(finding)})`,
        `  Warning: ${finding.warningId}`,
        `  Matched files: ${matchedFiles.join(", ")}`,
        `  Repair: ${finding.repairCommand}`
      ])
    : ["- No active Snitch findings are anchored to changed files."];

  return [
    "Snitch changed review",
    `- Git: ${payload.git.available ? "available" : `unavailable${payload.git.error ? ` (${payload.git.error})` : ""}`}`,
    `- Target: ${payload.target}`,
    `- Changed files: ${payload.counts.changedFiles}`,
    `- Changed files in target: ${payload.counts.targetChangedFiles}`,
    `- Findings on changed files: ${payload.counts.changedFindings}`,
    "",
    "Changed files:",
    ...changedFileLines,
    "",
    "Findings:",
    ...findingLines,
    "",
    "Next commands:",
    ...payload.nextCommands.map((command) => `- ${command}`)
  ].join("\n") + "\n";
}

function createChangedNextCommands(
  session: SnitchSession,
  changedFindings: ChangedFinding[]
): string[] {
  const commands = changedFindings.flatMap(({ finding }) => [
    `pnpm snitch trace --warning ${finding.warningId} --json`,
    finding.repairCommand
  ]);

  commands.push(
    `pnpm snitch check --target ${shellArgForPrompt(session.analysisTarget)} --fail-on medium --json`
  );

  return unique(commands);
}

async function readGitChangedFiles(cwd: string): Promise<{ available: boolean; files: ChangedFile[]; error?: string }> {
  const args = ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"];

  try {
    const { stdout } = await execFileAsync("git", args, {
      maxBuffer: 1024 * 1024
    });

    return {
      available: true,
      files: parseGitPorcelain(stdout)
    };
  } catch (error) {
    return {
      available: false,
      files: [],
      error: errorMessage(error)
    };
  }
}

function parseGitPorcelain(stdout: string): ChangedFile[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "modified";
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(" -> ");
      const oldPath = renameParts.length > 1 ? normalizePath(renameParts[0] ?? "") : undefined;
      const path = normalizePath(renameParts.at(-1) ?? rawPath);
      const file: ChangedFile = {
        status,
        path,
        inAnalysisTarget: false
      };

      if (oldPath) {
        file.oldPath = oldPath;
      }

      return file;
    });
}

function withTargetPath(cwd: string, target: string, file: ChangedFile): ChangedFile {
  const absoluteFile = resolve(cwd, file.path);
  const targetPath = relativePathWithin(target, absoluteFile);

  if (!targetPath) {
    return file;
  }

  return {
    ...file,
    targetPath,
    inAnalysisTarget: true
  };
}

function matchFindingToChangedFiles(
  finding: SnitchFinding,
  graph: SnitchGraph,
  changedFiles: ChangedFile[]
): ChangedFinding | undefined {
  const findingFiles = filesForFinding(finding, graph);
  const matchedFiles = unique(
    changedFiles
      .filter((file) => file.inAnalysisTarget)
      .flatMap((file) => {
        const candidate = file.targetPath ?? file.path;
        return findingFiles.some((findingFile) => pathsReferToSameFile(candidate, findingFile))
          ? [candidate]
          : [];
      })
  );

  return matchedFiles.length > 0 ? { finding, matchedFiles } : undefined;
}

function filesForFinding(finding: SnitchFinding, graph: SnitchGraph): string[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const files = new Set<string>();

  if (finding.anchor?.file) {
    files.add(normalizePath(finding.anchor.file));
  }

  for (const nodeId of finding.relatedNodeIds) {
    const node = nodeById.get(nodeId);

    if (node?.file) {
      files.add(normalizePath(node.file));
    }
  }

  return [...files];
}

function pathsReferToSameFile(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function relativePathWithin(parent: string, child: string): string | undefined {
  const relativePath = normalizePath(relative(parent, child));

  if (!relativePath || relativePath === ".") {
    return ".";
  }

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function readSnitchFindings(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const findings = await readSnitchFindingsPayload(cwd);

  if (flags.has("json")) {
    return `${JSON.stringify({ ok: true, cwd, findings }, null, 2)}\n`;
  }

  return formatSnitchFindings(findings);
}

async function readSnitchFindingsPayload(cwd: string): Promise<SnitchFinding[]> {
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    throw new Error("No Snitch graph found. Run `pnpm snitch analyze` or `pnpm snitch init` first.");
  }

  return buildSnitchFindings(graph, await readWarnings(cwd, graph));
}

function formatSnitchFindings(findings: SnitchFinding[]): string {
  if (findings.length === 0) {
    return "Snitch findings\n- No active Snitch findings.\n";
  }

  return [
    "Snitch findings",
    ...findings.flatMap((finding) => [
      `- [${finding.severity}] ${finding.title} (${formatFindingLocation(finding)})`,
      `  Warning: ${finding.warningId}`,
      `  Repair: ${finding.repairCommand}`,
      `  Evidence: ${finding.evidence.join("; ")}`
    ])
  ].join("\n") + "\n";
}

function formatFindingLocation(finding: SnitchFinding): string {
  if (!finding.anchor) {
    return "unanchored";
  }

  return typeof finding.anchor.line === "number"
    ? `${finding.anchor.file}:${finding.anchor.line}`
    : finding.anchor.file;
}

async function readSnitchNextAction(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const payload = await readSnitchNextActionPayload(cwd);

  if (flags.has("json")) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  return formatSnitchNextAction(payload);
}

async function readSnitchNextActionPayload(cwd: string): Promise<SnitchNextActionPayload> {
  const session = await readSession(cwd);
  const graph = await readGraphIfExists(cwd);

  if (!graph) {
    throw new Error("No Snitch graph found. Run `pnpm snitch analyze` or `pnpm snitch init` first.");
  }

  const warnings = await readWarnings(cwd, graph);
  const findings = buildSnitchFindings(graph, warnings);
  const insightsText = await readTextIfExists(cwd, ".snitch/insights.json");
  const insights = insightsText ? (JSON.parse(insightsText) as Partial<InsightArtifact>) : {};
  const rankings = Array.isArray(insights.rankedWarnings) ? insights.rankedWarnings : [];
  const orderedWarnings = orderWarningsForRepair(warnings, rankings);
  const warningRank = new Map(orderedWarnings.map((warning, index) => [warning.id, index]));
  const orderedFindings = [...findings].sort((left, right) => {
    const leftRank = warningRank.get(left.warningId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = warningRank.get(right.warningId) ?? Number.MAX_SAFE_INTEGER;

    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
  const topFinding = orderedFindings[0];
  const events = await readEvents(cwd);
  const relatedEvents = topFinding
    ? events.filter((event) => eventTouchesFinding(event, topFinding)).slice(-5).map(toSafeEventReference)
    : [];
  const latestEvent = events.at(-1);
  const status = topFinding ? "action_required" : "clear";
  const target = session.analysisTarget ?? ".";
  const nextCommands = topFinding
    ? [
        topFinding.repairCommand,
        `pnpm snitch impact --warning ${topFinding.warningId} --json`,
        `pnpm snitch check --target ${shellArgForPrompt(target)} --fail-on medium --json`
      ]
    : [
        `pnpm snitch check --target ${shellArgForPrompt(target)} --fail-on medium --json`,
        "pnpm snitch finalize"
      ];
  const payload: SnitchNextActionPayload = {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    status,
    task: session.task,
    counts: {
      warnings: warnings.length,
      findings: findings.length,
      anchoredFindings: findings.filter((finding) => Boolean(finding.anchor)).length,
      relatedEvents: relatedEvents.length
    },
    relatedEvents,
    agentInstruction: topFinding
      ? `Address ${topFinding.warningId} before continuing broad implementation. Run ${topFinding.repairCommand}, add the missing companion work, then rerun Snitch check.`
      : "No active Snitch findings. Continue implementation and run Snitch check before handoff.",
    nextCommands
  };

  if (topFinding) {
    payload.topFinding = topFinding;
  }

  if (latestEvent) {
    payload.latestEvent = toSafeEventReference(latestEvent);
  }

  return payload;
}

function formatSnitchNextAction(payload: SnitchNextActionPayload): string {
  const finding = payload.topFinding;
  const findingLines = finding
    ? [
        "Top finding:",
        `- [${finding.severity}] ${finding.title}`,
        `- Warning ID: ${finding.warningId}`,
        `- Anchor: ${formatFindingLocation(finding)}`,
        `- Repair: ${finding.repairCommand}`,
        "",
        "Evidence:",
        ...finding.evidence.map((item) => `- ${item}`)
      ]
    : ["Top finding:", "- none"];
  const relatedEventLines = payload.relatedEvents.length > 0
    ? payload.relatedEvents.map((event) => `- ${event.source}:${event.hook} ${formatSafeEventSummary(event)}`)
    : ["- none"];

  return [
    "# Snitch Next Action",
    "",
    `Status: ${payload.status}`,
    `Task: ${payload.task}`,
    `Active warnings: ${payload.counts.warnings}`,
    `Anchored findings: ${payload.counts.anchoredFindings}`,
    "",
    ...findingLines,
    "",
    "Likely related agent events:",
    ...relatedEventLines,
    "",
    "Instruction for the coding agent:",
    payload.agentInstruction,
    "",
    "Next commands:",
    ...payload.nextCommands.map((command) => `- ${command}`)
  ].join("\n") + "\n";
}

function formatNextActionSummary(payload: SnitchNextActionPayload): string {
  if (!payload.topFinding) {
    return "clear";
  }

  return `${payload.topFinding.warningId} at ${formatFindingLocation(payload.topFinding)}`;
}

function eventTouchesFinding(event: SnitchEvent, finding: SnitchFinding): boolean {
  const anchorFile = finding.anchor?.file;

  if (!anchorFile) {
    return false;
  }

  return eventFileReferences(event).some((file) => file === anchorFile || file.endsWith(`/${anchorFile}`));
}

function eventFileReferences(event: SnitchEvent): string[] {
  const files = new Set<string>();

  for (const evidence of event.evidence ?? []) {
    files.add(evidence.file);
  }

  for (const key of ["file_path", "file", "path"]) {
    const value = event.safeSummary[key];

    if (typeof value === "string") {
      files.add(value);
    }
  }

  return [...files];
}

function toSafeEventReference(event: SnitchEvent): SafeEventReference {
  const reference: SafeEventReference = {
    id: event.id,
    source: event.source,
    phase: event.phase,
    hook: event.hook,
    receivedAt: event.receivedAt,
    safeSummary: event.safeSummary
  };

  if (event.evidence) {
    reference.evidence = event.evidence;
  }

  return reference;
}

function formatSafeEventSummary(event: SafeEventReference): string {
  const tool = event.safeSummary.tool_name ?? event.safeSummary.tool;
  const file = event.safeSummary.file_path ?? event.safeSummary.file ?? event.safeSummary.path;
  const parts = [
    typeof tool === "string" ? `tool=${tool}` : undefined,
    typeof file === "string" ? `file=${file}` : undefined
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

async function startMcpStdioServer(cwd: string): Promise<void> {
  process.stdin.setEncoding("utf8");

  let buffer = "";
  let chain = Promise.resolve();

  await new Promise<void>((resolveServer) => {
    process.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        chain = chain.then(() => processMcpLine(cwd, line));
      }
    });

    process.stdin.on("end", () => {
      const trailingLine = buffer;
      buffer = "";

      if (trailingLine.trim()) {
        chain = chain.then(() => processMcpLine(cwd, trailingLine));
      }

      void chain.finally(resolveServer);
    });

    process.stdin.resume();
  });
}

async function processMcpLine(cwd: string, line: string): Promise<void> {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  try {
    const message = JSON.parse(trimmed) as unknown;
    const response = await handleMcpJsonRpcMessage(cwd, message);

    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch {
    process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
  }
}

export async function handleMcpJsonRpcMessage(
  cwd: string,
  message: unknown
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(message)) {
    const responses: JsonRpcResponse[] = [];

    for (const item of message) {
      const response = await handleMcpJsonRpcMessage(cwd, item);

      if (Array.isArray(response)) {
        responses.push(...response);
      } else if (response) {
        responses.push(response);
      }
    }

    return responses.length > 0 ? responses : undefined;
  }

  if (!isJsonRpcRequest(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");

  if (!hasId) {
    return undefined;
  }

  try {
    if (message.method === "initialize") {
      return jsonRpcResult(message.id ?? null, createMcpInitializeResult(message.params));
    }

    if (message.method === "ping") {
      return jsonRpcResult(message.id ?? null, {});
    }

    if (message.method === "tools/list") {
      return jsonRpcResult(message.id ?? null, { tools: createMcpTools() });
    }

    if (message.method === "tools/call") {
      return jsonRpcResult(message.id ?? null, await callMcpTool(cwd, message.params));
    }

    return jsonRpcError(message.id ?? null, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    return jsonRpcError(message.id ?? null, -32603, errorMessage(error));
  }
}

function createMcpInitializeResult(params: unknown): Record<string, unknown> {
  const requestedVersion = isRecord(params) && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : "2025-11-25";

  return {
    protocolVersion: requestedVersion,
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    serverInfo: {
      name: "snitch",
      title: "Snitch",
      version: "0.1.0"
    },
    instructions:
      "Use Snitch tools to inspect setup readiness, the local .snitch graph, changed files, active warnings, safe agent events, warning traces, next action, and repair prompts for AI coding-agent changes."
  };
}

function createMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "snitch_status",
      title: "Snitch Status",
      description:
        "Return the local Snitch session summary, counts, active warnings, safe recent events, artifacts, integrations, and next commands.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_doctor",
      title: "Snitch Doctor",
      description:
        "Return local Snitch setup readiness for coding agents, including hook adapter, generated agent configs, artifacts, Git hooks, providers, and next commands.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_check",
      title: "Snitch Check",
      description:
        "Run the local Snitch verification gate, refresh .snitch artifacts, and return blocking warnings as structured JSON.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          },
          target: {
            type: "string",
            description: "TypeScript target to analyze. Defaults to the stored Snitch analysis target."
          },
          task: {
            type: "string",
            description: "Task intent used in generated artifacts. Defaults to the stored Snitch task."
          },
          failOn: {
            type: "string",
            enum: ["info", "low", "medium", "high"],
            description: "Minimum warning severity that fails the gate. Defaults to high."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_findings",
      title: "Snitch Findings",
      description:
        "Return active Snitch warnings as anchored review findings with file, line, evidence, and repair commands.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_next_action",
      title: "Snitch Next Action",
      description:
        "Return the highest-priority grounded follow-up for the coding agent, including finding anchor, related safe events, and commands.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_trace",
      title: "Snitch Warning Trace",
      description:
        "Trace an active Snitch warning to its anchored finding, likely related safe hook events, graph timeline, and repair commands.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          },
          warning: {
            type: "string",
            description: "Warning id. Defaults to the highest-severity active warning."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_changed",
      title: "Snitch Changed Review",
      description:
        "Return local Git changed files and the active Snitch findings anchored to those changed files.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          },
          target: {
            type: "string",
            description: "Analysis target. Defaults to the stored Snitch analysis target."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_impact",
      title: "Snitch Warning Impact",
      description:
        "Return the graph neighborhood, files, nodes, edges, and repair command for an active Snitch warning.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          },
          warning: {
            type: "string",
            description: "Warning id. Defaults to the highest-severity active warning."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "snitch_repair_prompt",
      title: "Snitch Repair Prompt",
      description:
        "Return the paste-ready coding-agent repair prompt for an active Snitch warning.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository root. Defaults to the MCP server working directory."
          },
          warning: {
            type: "string",
            description: "Warning id. Defaults to the highest-priority active warning."
          },
          all: {
            type: "boolean",
            description: "Return repair prompts for all active warnings."
          }
        },
        additionalProperties: false
      }
    }
  ];
}

async function callMcpTool(cwd: string, params: unknown): Promise<McpToolResult> {
  const paramsRecord = isRecord(params) ? params : {};
  const name = typeof paramsRecord.name === "string" ? paramsRecord.name : "";
  const args = isRecord(paramsRecord.arguments) ? paramsRecord.arguments : {};
  const toolCwd = resolveMcpCwd(cwd, args);

  try {
    if (name === "snitch_status") {
      const payload = await readSnitchStatusPayload(toolCwd);
      return jsonMcpToolResult(payload);
    }

    if (name === "snitch_doctor") {
      return jsonMcpToolResult(await readSnitchDoctorPayload(toolCwd));
    }

    if (name === "snitch_check") {
      return await callMcpCheckTool(toolCwd, args);
    }

    if (name === "snitch_findings") {
      const findings = await readSnitchFindingsPayload(toolCwd);
      return jsonMcpToolResult({ ok: true, cwd: toolCwd, findings });
    }

    if (name === "snitch_next_action") {
      return jsonMcpToolResult(await readSnitchNextActionPayload(toolCwd));
    }

    if (name === "snitch_trace") {
      return jsonMcpToolResult(await readSnitchTracePayload(toolCwd, mcpFlags(args)));
    }

    if (name === "snitch_changed") {
      return jsonMcpToolResult(await readSnitchChangedPayload(toolCwd, mcpFlags(args)));
    }

    if (name === "snitch_impact") {
      const payload = await readSnitchImpactPayload(toolCwd, mcpFlags(args));
      return jsonMcpToolResult(payload);
    }

    if (name === "snitch_repair_prompt") {
      return {
        content: [
          {
            type: "text",
            text: await readRepairPrompt(toolCwd, mcpFlags(args))
          }
        ],
        isError: false
      };
    }

    return {
      content: [{ type: "text", text: `Unknown Snitch MCP tool: ${name || "(missing)"}` }],
      isError: true
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: errorMessage(error) }],
      isError: true
    };
  }
}

async function callMcpCheckTool(cwd: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const session = await readSessionIfExists(cwd);
  const targetInput = typeof args.target === "string"
    ? args.target
    : session?.analysisTarget ?? ".";
  const target = resolveStoredTarget(cwd, targetInput);
  const task = typeof args.task === "string"
    ? args.task
    : session?.task ?? defaultTask;
  const flags = new Map<string, string | true>([["json", true]]);

  if (typeof args.failOn === "string") {
    flags.set("fail-on", args.failOn);
  }

  const result = await checkTypeScriptRepo(cwd, target, task, new Date(), flags);
  const structuredContent = parseStructuredToolJson(result.stdout, {
    ok: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout
  });

  return {
    content: [{ type: "text", text: `${JSON.stringify(structuredContent, null, 2)}\n` }],
    structuredContent,
    isError: result.code !== 0
  };
}

function jsonMcpToolResult(value: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: false
  };
}

function mcpFlags(args: Record<string, unknown>): ParsedArgs["flags"] {
  const flags = new Map<string, string | true>();

  if (typeof args.warning === "string") {
    flags.set("warning", args.warning);
  }

  if (typeof args.target === "string") {
    flags.set("target", args.target);
  }

  if (args.all === true) {
    flags.set("all", true);
  }

  return flags;
}

async function readSessionIfExists(cwd: string): Promise<SnitchSession | undefined> {
  try {
    return await readSession(cwd);
  } catch {
    return undefined;
  }
}

async function readConfigIfExists(cwd: string): Promise<SnitchConfig | undefined> {
  try {
    return await readConfig(cwd);
  } catch {
    return undefined;
  }
}

function parseStructuredToolJson(
  text: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;

    if (isRecord(parsed)) {
      return {
        ...parsed,
        exitCode: fallback.exitCode
      };
    }
  } catch {
    // fall through to fallback
  }

  return fallback;
}

function resolveMcpCwd(baseCwd: string, args: Record<string, unknown>): string {
  return typeof args.cwd === "string" && args.cwd.trim()
    ? resolve(baseCwd, args.cwd)
    : baseCwd;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
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

async function startLiveServer(cwd: string, options: LiveServerOptions): Promise<string> {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      writeCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/state") {
      try {
        sendJson(response, 200, await readLiveState(cwd));
      } catch (error) {
        sendError(response, error);
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/events") {
      handleLiveEvents(cwd, response, options.intervalMs);
      request.on("close", () => response.end());
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/events") {
      try {
        const source = requestUrl.searchParams.get("source") ?? "agent";
        const hook = requestUrl.searchParams.get("hook") ?? "agent-event";
        const body = await readRequestBody(request);
        sendJson(
          response,
          202,
          await ingestHookEvent(cwd, {
            source,
            hook,
            body,
            now: new Date()
          })
        );
      } catch (error) {
        sendError(response, error);
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const fileRefreshOptions: {
    target?: string;
    scanIntervalMs: number;
  } = {
    scanIntervalMs: options.scanIntervalMs
  };

  if (options.target) {
    fileRefreshOptions.target = options.target;
  }

  const stopFileWatcher = options.fileWatch
    ? startFileRefreshLoop(cwd, fileRefreshOptions)
    : undefined;
  server.on("close", () => stopFileWatcher?.());
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;

  return `http://127.0.0.1:${actualPort}`;
}

export async function ingestHookEvent(
  cwd: string,
  input: {
    source: string;
    hook: string;
    body: string;
    now: Date;
  }
): Promise<HookIngestResult> {
  const message = await recordSnitchEvent(cwd, {
    source: input.source,
    hook: input.hook,
    stdin: input.body,
    now: input.now
  });
  const nextAction = await readSnitchNextActionPayload(cwd);

  return {
    ok: true,
    message,
    agentFeedback: formatSnitchNextAction(nextAction),
    nextAction
  };
}

function startFileRefreshLoop(
  cwd: string,
  input: {
    target?: string;
    scanIntervalMs: number;
  }
): () => void {
  let lastFingerprint = "";
  let running = false;
  let stopped = false;

  async function scan(): Promise<void> {
    if (running || stopped) {
      return;
    }

    running = true;
    try {
      const target = await resolveWatchTarget(cwd, input.target);
      const fingerprint = await fingerprintWatchTarget(target);

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        await refreshWatchedTarget(cwd, {
          target,
          now: new Date()
        });
      }
    } catch {
      // The live server keeps serving the last valid graph. Refresh errors are persisted by refreshWatchedTarget when possible.
    } finally {
      running = false;
    }
  }

  void scan();
  const interval = setInterval(() => void scan(), input.scanIntervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export async function refreshWatchedTarget(
  cwd: string,
  input: {
    target?: string;
    now: Date;
  }
): Promise<WatchRefreshResult> {
  await ensureInitialized(cwd, input.now);

  const session = await readSession(cwd);
  const config = await readConfig(cwd);
  const target = await resolveWatchTarget(cwd, input.target ?? resolveStoredTarget(cwd, session.analysisTarget ?? config.analysis.target));

  try {
    const analysis = await writeTypeScriptArtifacts(cwd, {
      target,
      task: session.task,
      now: input.now,
      runId: session.runId,
      appendTimeline: true
    });
    const updatedSession: SnitchSession = {
      ...session,
      status: session.status === "finalized" ? "finalized" : "running",
      lastEventAt: input.now.toISOString(),
      snapshotId: analysis.snapshot.id,
      graphSource: "typescript",
      analysisTarget: analysis.target,
      lastAnalyzedAt: analysis.analyzedAt
    };

    delete updatedSession.lastAnalysisError;
    await writeJson(cwd, ".snitch/session.json", updatedSession);

    return {
      status: "updated",
      target,
      message: `refreshed from file watcher target ${analysis.target}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updatedSession: SnitchSession = {
      ...session,
      lastEventAt: input.now.toISOString(),
      lastAnalysisError: message
    };

    await writeJson(cwd, ".snitch/session.json", updatedSession);

    return {
      status: "kept-last-good",
      target,
      message: `kept last valid graph; watcher extraction failed (${message})`
    };
  }
}

export async function readLiveState(cwd: string): Promise<LiveState> {
  const graph = JSON.parse(await readFile(resolve(cwd, ".snitch/graph.json"), "utf8")) as SnitchGraph;
  const warnings = await readWarnings(cwd, graph);
  const events = await readEvents(cwd);
  const sessionText = await readTextIfExists(cwd, ".snitch/session.json");
  const insightsText = await readTextIfExists(cwd, ".snitch/insights.json");
  const memoryText = await readTextIfExists(cwd, ".snitch/memory.json");
  const state: LiveState = {
    ok: true,
    cwd,
    generatedAt: new Date().toISOString(),
    session: sessionText ? JSON.parse(sessionText) : null,
    graph,
    warnings,
    events: events.slice(-50),
    artifacts: {
      findings: await readTextIfExists(cwd, ".snitch/findings.json"),
      nextAction: await readTextIfExists(cwd, ".snitch/next-action.md"),
      mermaid: await readTextIfExists(cwd, ".snitch/mermaid.mmd"),
      prComment: await readTextIfExists(cwd, ".snitch/pr-comment.md"),
      handoff: await readTextIfExists(cwd, ".snitch/handoff.md"),
      timeline: await readTextIfExists(cwd, ".snitch/timeline.jsonl")
    }
  };

  if (insightsText) {
    state.insights = JSON.parse(insightsText) as InsightArtifact;
  }

  if (memoryText) {
    state.memory = JSON.parse(memoryText) as MemoryArtifact;
  }

  return state;
}

function handleLiveEvents(cwd: string, response: ServerResponse, intervalMs: number): void {
  writeCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  let lastHash = "";
  let closed = false;

  async function sendIfChanged(): Promise<void> {
    if (closed) {
      return;
    }

    try {
      const state = await readLiveState(cwd);
      const stateHash = hashLiveState(state);

      if (stateHash !== lastHash) {
        lastHash = stateHash;
        response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: message })}\n\n`);
    }
  }

  void sendIfChanged();
  const interval = setInterval(() => void sendIfChanged(), intervalMs);

  response.on("close", () => {
    closed = true;
    clearInterval(interval);
  });
}

async function writeInsightArtifacts(cwd: string, options: InsightOptions): Promise<string> {
  const graph = JSON.parse(await readFile(resolve(cwd, ".snitch/graph.json"), "utf8")) as SnitchGraph;
  const warnings = await readWarnings(cwd, graph);
  const sessionText = await readTextIfExists(cwd, ".snitch/session.json");
  const session = sessionText ? (JSON.parse(sessionText) as { task?: string }) : {};
  const task = session.task ?? defaultTask;
  const previousGraph: SnitchGraph = {
    id: "insight-baseline",
    title: "Insight baseline",
    nodes: [],
    edges: []
  };
  const diff = diffGraph(previousGraph, graph);
  const env = options.offline ? {} : await loadRuntimeEnv(cwd);
  const fetcher = options.offline ? undefined : createTimeoutFetcher(1600);
  const backboardInput: Parameters<typeof loadBackboardRepoRules>[0] = { task };

  if (env.BACKBOARD_API_KEY) {
    backboardInput.apiKey = env.BACKBOARD_API_KEY;
  }

  if (env.BACKBOARD_ASSISTANT_ID) {
    backboardInput.assistantId = env.BACKBOARD_ASSISTANT_ID;
  }

  if (fetcher) {
    backboardInput.fetcher = fetcher;
  }

  const backboard = await loadBackboardRepoRules(backboardInput);
  const narrationInput = createCerebrasNarrationInput({
    task,
    diff,
    warnings,
    repoRules: backboard.rules
  });
  const cerebrasInput: Parameters<typeof narrateWithCerebras>[0] = {
    model: env.CEREBRAS_MODEL || "gpt-oss-120b",
    input: narrationInput
  };

  if (env.CEREBRAS_API_KEY) {
    cerebrasInput.apiKey = env.CEREBRAS_API_KEY;
  }

  if (fetcher) {
    cerebrasInput.fetcher = fetcher;
  }

  const cerebras = await narrateWithCerebras(cerebrasInput);
  const triageInput = createCerebrasWarningTriageInput({
    task,
    warnings,
    repoRules: backboard.rules
  });
  const warningTriageInput: Parameters<typeof rankWarningsWithCerebras>[0] = {
    model: env.CEREBRAS_MODEL || "gpt-oss-120b",
    input: triageInput,
    warnings
  };

  if (env.CEREBRAS_API_KEY) {
    warningTriageInput.apiKey = env.CEREBRAS_API_KEY;
  }

  if (fetcher) {
    warningTriageInput.fetcher = fetcher;
  }

  const warningTriage = await rankWarningsWithCerebras(warningTriageInput);
  const artifact: InsightArtifact = {
    generatedAt: options.now.toISOString(),
    narration:
      cerebras.status === "disabled" || cerebras.status === "fallback"
        ? createStaticNarration(diff, warnings)
        : cerebras.text,
    cerebras: {
      status: cerebras.status,
      triageStatus: warningTriage.status
    },
    backboard: {
      status: backboard.status,
      rules: backboard.rules
    },
    rankedWarnings: warningTriage.rankedWarnings
  };

  if (cerebras.model) {
    artifact.cerebras.model = cerebras.model;
  } else if (warningTriage.model) {
    artifact.cerebras.model = warningTriage.model;
  }

  await writeJson(cwd, ".snitch/insights.json", artifact);

  return [
    "Snitch insights artifact written.",
    `- Cerebras: ${artifact.cerebras.status} narration / ${artifact.cerebras.triageStatus} triage${artifact.cerebras.model ? ` (${artifact.cerebras.model})` : ""}`,
    `- Backboard: ${artifact.backboard.status} / ${artifact.backboard.rules.length} rules`,
    `- Ranked warnings: ${artifact.rankedWarnings.length}`,
    "- Updated: .snitch/insights.json"
  ].join("\n") + "\n";
}

async function readRepairPrompt(cwd: string, flags: ParsedArgs["flags"]): Promise<string> {
  const graph = JSON.parse(await readFile(resolve(cwd, ".snitch/graph.json"), "utf8")) as SnitchGraph;
  const warnings = await readWarnings(cwd, graph);

  if (warnings.length === 0) {
    return "No active Snitch warnings.\n";
  }

  const sessionText = await readTextIfExists(cwd, ".snitch/session.json");
  const insightsText = await readTextIfExists(cwd, ".snitch/insights.json");
  const session = sessionText ? (JSON.parse(sessionText) as Partial<SnitchSession>) : {};
  const insights = insightsText ? (JSON.parse(insightsText) as Partial<InsightArtifact>) : {};
  const rankings = Array.isArray(insights.rankedWarnings) ? insights.rankedWarnings : [];
  const warningIdFlag = flags.get("warning");
  const requestedWarningId = warningIdFlag && warningIdFlag !== true ? warningIdFlag : undefined;
  const selectedWarnings = flags.has("all")
    ? orderWarningsForRepair(warnings, rankings)
    : [selectRepairWarning(warnings, rankings, requestedWarningId)];
  const task = typeof session.task === "string" ? session.task : defaultTask;
  const target = typeof session.analysisTarget === "string" ? session.analysisTarget : ".";

  return selectedWarnings
    .map((warning) => {
      const ranking = rankings.find((item) => item.warningId === warning.id);
      const context: RepairPromptContext = {
        warning,
        task,
        target
      };

      if (ranking) {
        context.ranking = ranking;
      }

      return formatRepairPrompt(context);
    })
    .join("\n---\n") + "\n";
}

function selectRepairWarning(
  warnings: SnitchWarning[],
  rankings: RankedWarning[],
  requestedWarningId: string | undefined
): SnitchWarning {
  if (requestedWarningId) {
    const requested = warnings.find((warning) => warning.id === requestedWarningId);

    if (!requested) {
      throw new Error(`No active Snitch warning matches ${requestedWarningId}.`);
    }

    return requested;
  }

  const [firstWarning] = orderWarningsForRepair(warnings, rankings);

  if (!firstWarning) {
    throw new Error("No active Snitch warnings.");
  }

  return firstWarning;
}

function orderWarningsForRepair(warnings: SnitchWarning[], rankings: RankedWarning[]): SnitchWarning[] {
  const rankingByWarningId = new Map(rankings.map((ranking) => [ranking.warningId, ranking]));

  return [...warnings].sort((left, right) => {
    const leftRanking = rankingByWarningId.get(left.id);
    const rightRanking = rankingByWarningId.get(right.id);

    if (leftRanking && rightRanking) {
      return leftRanking.rank - rightRanking.rank;
    }

    if (leftRanking) {
      return -1;
    }

    if (rightRanking) {
      return 1;
    }

    return warningSeverityRank(right.severity) - warningSeverityRank(left.severity);
  });
}

function formatRepairPrompt(context: RepairPromptContext): string {
  const reason = context.ranking?.reason;
  const instruction = context.ranking?.repairPrompt || context.warning.repairPrompt || context.warning.message;

  return [
    "# Snitch Repair Prompt",
    "",
    `Task: ${context.task}`,
    `Target: ${context.target}`,
    "",
    `Warning: ${context.warning.title}`,
    `Warning ID: ${context.warning.id}`,
    `Severity: ${context.warning.severity}`,
    context.ranking ? `Priority: #${context.ranking.rank} ${context.ranking.priority}` : undefined,
    reason ? `Why now: ${reason}` : undefined,
    "",
    "Evidence:",
    ...context.warning.evidence.map((item) => `- ${item}`),
    "",
    "Instruction for the coding agent:",
    instruction,
    "",
    "Acceptance checks:",
    `- Re-run \`pnpm snitch analyze --target ${shellArgForPrompt(context.target)} --task ${shellArgForPrompt(context.task)}\`.`,
    `- Confirm warning \`${context.warning.id}\` is gone from \`.snitch/warnings.json\`.`,
    "- Run the relevant tests for the changed tool, route, or permission path."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function warningSeverityRank(severity: SnitchWarning["severity"]): number {
  return {
    info: 0,
    low: 1,
    medium: 2,
    high: 3
  }[severity];
}

function parseCheckThreshold(value: string | true | undefined): CheckThreshold {
  if (!value || value === true) {
    return "high";
  }

  if (isWarningSeverity(value)) {
    return value;
  }

  throw new Error(`Invalid check threshold ${value}. Expected info, low, medium, or high.`);
}

function warningsAtOrAboveThreshold(
  warnings: SnitchWarning[],
  threshold: CheckThreshold
): SnitchWarning[] {
  const thresholdRank = warningSeverityRank(threshold);

  return warnings
    .filter((warning) => warningSeverityRank(warning.severity) >= thresholdRank)
    .sort(
      (left, right) =>
        warningSeverityRank(right.severity) - warningSeverityRank(left.severity) ||
        left.id.localeCompare(right.id)
    );
}

function shellArgForPrompt(value: string): string {
  return value.includes(" ") || value.includes("'") || value.includes("\"")
    ? shellQuote(value)
    : value;
}

async function rememberWarningsOnFinalize(cwd: string, now: Date): Promise<MemoryArtifact> {
  const graph = JSON.parse(await readFile(resolve(cwd, ".snitch/graph.json"), "utf8")) as SnitchGraph;
  const warnings = await readWarnings(cwd, graph);
  const warningIds = warnings.map((warning) => warning.id);
  const env = await loadRuntimeEnv(cwd);
  const artifact: MemoryArtifact = {
    generatedAt: now.toISOString(),
    backboard: {
      status: "disabled",
      decision: "accepted",
      rememberedWarnings: 0,
      warningIds
    }
  };

  const apiKey = env.BACKBOARD_API_KEY;

  if (!apiKey) {
    await writeJson(cwd, ".snitch/memory.json", artifact);
    return artifact;
  }

  const fetcher = createTimeoutFetcher(1600);
  const results = await Promise.all(warnings.map((warning) => {
    const input: Parameters<typeof rememberBackboardWarningDecision>[0] = {
      apiKey,
      warning,
      decision: "accepted",
      fetcher
    };

    if (env.BACKBOARD_ASSISTANT_ID) {
      input.assistantId = env.BACKBOARD_ASSISTANT_ID;
    }

    return rememberBackboardWarningDecision(input);
  }));
  const rememberedWarnings = results.filter((result) => result.status === "ok").length;
  const status: IntegrationStatus =
    results.length === 0 || rememberedWarnings === results.length ? "ok" : "fallback";

  artifact.backboard.status = status;
  artifact.backboard.rememberedWarnings = rememberedWarnings;
  await writeJson(cwd, ".snitch/memory.json", artifact);

  return artifact;
}

function formatMemoryStatus(memory: MemoryArtifact): string {
  return `- Backboard memory: ${memory.backboard.status} / ${memory.backboard.rememberedWarnings} warning decisions`;
}

async function publishGithubComment(
  cwd: string,
  flags: ParsedArgs["flags"],
  fetcher: typeof fetch
): Promise<string> {
  const options = await resolveGithubPublishOptions(flags);
  const artifact = await readTextIfExists(cwd, options.commentPath);

  if (!artifact.trim()) {
    throw new Error(`Missing PR comment artifact at ${options.commentPath}`);
  }

  const body = `${options.marker}\n${artifact.trim()}\n`;
  const commentsUrl = githubApiUrl(
    options,
    `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/comments`
  );
  const commentsResponse = await fetcher(`${commentsUrl}?per_page=100`, {
    method: "GET",
    headers: githubHeaders(options.token)
  });

  if (!commentsResponse.ok) {
    throw new Error(`GitHub comments lookup failed with ${commentsResponse.status}`);
  }

  const comments = (await commentsResponse.json()) as GitHubComment[];
  const existing = comments.find((comment) => comment.body?.includes(options.marker));
  const publishResponse = existing
    ? await fetcher(githubApiUrl(options, `/repos/${options.owner}/${options.repo}/issues/comments/${existing.id}`), {
        method: "PATCH",
        headers: githubHeaders(options.token),
        body: JSON.stringify({ body })
      })
    : await fetcher(commentsUrl, {
        method: "POST",
        headers: githubHeaders(options.token),
        body: JSON.stringify({ body })
      });

  if (!publishResponse.ok) {
    throw new Error(`GitHub comment publish failed with ${publishResponse.status}`);
  }

  const published = (await publishResponse.json()) as GitHubComment;
  const action = existing ? "updated" : "created";

  return [
    `Snitch ${action} the PR summary comment.`,
    `- Repository: ${options.owner}/${options.repo}`,
    `- Pull request: #${options.issueNumber}`,
    published.html_url ? `- Comment: ${published.html_url}` : "- Comment: published"
  ].join("\n") + "\n";
}

async function resolveGithubPublishOptions(flags: ParsedArgs["flags"]): Promise<GitHubPublishOptions> {
  const repository = String(flags.get("repo") ?? process.env.GITHUB_REPOSITORY ?? "");
  const [owner, repo] = repository.includes("/")
    ? repository.split("/", 2)
    : [
        String(flags.get("owner") ?? ""),
        repository || String(flags.get("name") ?? "")
      ];
  const issueNumber = parsePositiveInt(flags.get("pr") ?? flags.get("issue"))
    ?? await readGithubEventIssueNumber();
  const token = String(flags.get("token") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "");
  const apiUrl = String(flags.get("api-url") ?? process.env.GITHUB_API_URL ?? "https://api.github.com");
  const commentPath = String(flags.get("comment-path") ?? ".snitch/pr-comment.md");
  const marker = String(flags.get("marker") ?? "<!-- snitch-pr-summary -->");

  if (!owner || !repo) {
    throw new Error("Missing GitHub repository. Pass --repo owner/name or set GITHUB_REPOSITORY.");
  }

  if (!issueNumber) {
    throw new Error("Missing pull request number. Pass --pr <number> or set GITHUB_EVENT_PATH.");
  }

  if (!token.trim()) {
    throw new Error("Missing GitHub token. Pass --token or set GITHUB_TOKEN.");
  }

  return {
    owner,
    repo,
    issueNumber,
    token,
    apiUrl,
    commentPath,
    marker
  };
}

async function readGithubEventIssueNumber(): Promise<number | undefined> {
  if (!process.env.GITHUB_EVENT_PATH) {
    return undefined;
  }

  try {
    const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) as {
      pull_request?: { number?: number };
      issue?: { number?: number };
      number?: number;
    };

    return payload.pull_request?.number ?? payload.issue?.number ?? payload.number;
  } catch {
    return undefined;
  }
}

function githubApiUrl(options: GitHubPublishOptions, path: string): string {
  return `${options.apiUrl.replace(/\/$/, "")}${path}`;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function parsePositiveInt(value: string | true | undefined): number | undefined {
  if (!value || value === true) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function resolveWatchTarget(cwd: string, target?: string): Promise<string> {
  if (target) {
    return resolveStoredTarget(cwd, target);
  }

  const session = await readSession(cwd);
  const config = await readConfig(cwd);

  return resolveStoredTarget(cwd, session.analysisTarget ?? config.analysis.target);
}

async function fingerprintWatchTarget(target: string): Promise<string> {
  const files = await listWatchableFiles(target);
  const entries = await Promise.all(
    files.map(async (file) => {
      const fileStat = await stat(file);

      return {
        file: relative(target, file),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
    })
  );

  return hashJson(entries.sort((left, right) => left.file.localeCompare(right.file)));
}

async function listWatchableFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = resolve(directory, entry.name);

        if (entry.isDirectory()) {
          if (!ignoredWatchDirectory(entry.name)) {
            await visit(entryPath);
          }
          return;
        }

        if (entry.isFile() && watchableCodePath(entry.name)) {
          files.push(entryPath);
        }
      })
    );
  }

  await visit(root);

  return files;
}

function ignoredWatchDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".next",
    ".snitch",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report"
  ]).has(name);
}

function watchableCodePath(path: string): boolean {
  return /\.(cjs|cts|js|jsx|json|mjs|mts|ts|tsx)$/.test(path);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  writeCorsHeaders(response);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 500, { ok: false, error: message });
}

function writeCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readRequestBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;

    if (bytes > maxBytes) {
      throw new Error(`Hook payload exceeds ${maxBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readTextIfExists(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch {
    return "";
  }
}

async function readGraphIfExists(cwd: string): Promise<SnitchGraph | undefined> {
  const graphText = await readTextIfExists(cwd, ".snitch/graph.json");

  if (!graphText.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(graphText) as SnitchGraph;
  } catch {
    return undefined;
  }
}

async function readAbsoluteTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function loadRuntimeEnv(cwd: string): Promise<Record<string, string>> {
  const localEnvText = await readTextIfExists(cwd, ".env");
  const localEnv = Object.fromEntries(
    localEnvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  const processEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  return {
    ...localEnv,
    ...processEnv
  };
}

function createTimeoutFetcher(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function warningsFromGraph(graph: SnitchGraph): SnitchWarning[] {
  return graph.nodes
    .filter((node) => node.kind === "warning")
    .map((node) => {
      const meta = node.meta ?? {};
      const severity = typeof meta.severity === "string" ? meta.severity : "medium";
      const evidence = Array.isArray(meta.evidence)
        ? meta.evidence.filter((item): item is string => typeof item === "string")
        : [];

      const warning: SnitchWarning = {
        id: node.id,
        kind: "warning",
        severity: isWarningSeverity(severity) ? severity : "medium",
        title: node.label,
        message: typeof meta.message === "string" ? meta.message : node.label,
        evidence
      };

      if (typeof meta.repairPrompt === "string") {
        warning.repairPrompt = meta.repairPrompt;
      }

      return warning;
    });
}

function isWarningSeverity(value: string): value is SnitchWarning["severity"] {
  return value === "info" || value === "low" || value === "medium" || value === "high";
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashLiveState(state: LiveState): string {
  return hashJson({
    session: state.session,
    graph: state.graph,
    warnings: state.warnings,
    events: state.events,
    insights: state.insights,
    memory: state.memory,
    artifacts: state.artifacts
  });
}

async function readWarnings(cwd: string, graph: SnitchGraph): Promise<SnitchWarning[]> {
  const warningsText = await readTextIfExists(cwd, ".snitch/warnings.json");

  return warningsText
    ? (JSON.parse(warningsText) as SnitchWarning[])
    : warningsFromGraph(graph);
}

async function updateGraphForEvent(
  cwd: string,
  input: {
    event: SnitchEvent;
    eventCount: number;
    session: SnitchSession;
    config: SnitchConfig;
    now: Date;
  }
): Promise<EventGraphUpdate> {
  const target = resolveStoredTarget(cwd, input.session.analysisTarget ?? input.config.analysis.target);

  if (shouldRefreshFromEvent(input.event)) {
    try {
      const analysis = await writeTypeScriptArtifacts(cwd, {
        target,
        task: input.session.task,
        now: input.now,
        runId: input.session.runId,
        appendTimeline: true
      });

      if (analysis.snapshot.graph.nodes.length > 0) {
        return {
          graphSource: "typescript",
          snapshotId: analysis.snapshot.id,
          lastAnalyzedAt: analysis.analyzedAt,
          message: `refreshed from TypeScript target ${analysis.target}`
        };
      }

      return await writeReplayGraphForEvent(cwd, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        graphSource: input.session.graphSource ?? "replay",
        snapshotId: input.session.snapshotId,
        message: `kept last valid graph; TypeScript extraction failed (${message})`,
        lastAnalysisError: message
      };
    }
  }

  if (input.session.graphSource === "typescript") {
    return {
      graphSource: "typescript",
      snapshotId: input.session.snapshotId,
      lastAnalyzedAt: input.session.lastAnalyzedAt ?? input.now.toISOString(),
      message: "kept current TypeScript graph"
    };
  }

  return writeReplayGraphForEvent(cwd, input);
}

async function writeReplayGraphForEvent(
  cwd: string,
  input: {
    eventCount: number;
    session: SnitchSession;
  }
): Promise<EventGraphUpdate> {
  const replay = getDemoReplay();
  const snapshot = pickSnapshotForEventCount(replay, input.eventCount);

  await writeReplayArtifacts(cwd, {
    replay,
    snapshot,
    runId: input.session.runId,
    task: input.session.task,
    createdAt: input.session.startedAt,
    source: "snitch-background"
  });

  return {
    graphSource: "replay",
    snapshotId: snapshot.id,
    message: `advanced replay snapshot ${snapshot.title}`
  };
}

async function writeTypeScriptArtifacts(
  cwd: string,
  input: {
    target: string;
    task: string;
    now: Date;
    runId: string;
    appendTimeline?: boolean;
  }
): Promise<AnalysisWriteResult> {
  const analyzedAt = input.now.toISOString();
  const previousGraph = input.appendTimeline ? await readGraphIfExists(cwd) : undefined;
  const previousTimeline = input.appendTimeline ? await readTextIfExists(cwd, ".snitch/timeline.jsonl") : "";
  const extracted = extractTypeScriptGraph({
    cwd: input.target,
    title: `Extracted graph for ${basename(input.target) || "repo"}`,
    generatedAt: analyzedAt
  });
  const artifacts = buildSnitchArtifacts({
    replay: [extracted.snapshot],
    reviewSnapshot: extracted.snapshot,
    createdAt: analyzedAt,
    runId: input.runId,
    task: input.task,
    source: "snitch-ts-extractor"
  });

  await writeArtifacts(cwd, artifacts);

  if (input.appendTimeline) {
    await writeText(
      cwd,
      ".snitch/timeline.jsonl",
      appendTimelineEntry(previousTimeline, createLiveTimelineEntry({
        snapshot: extracted.snapshot,
        previousGraph,
        generatedAt: analyzedAt,
        source: "snitch-ts-extractor"
      }))
    );
  }

  return {
    snapshot: extracted.snapshot,
    graphSource: "typescript",
    target: storeTargetPath(cwd, input.target),
    analyzedAt
  };
}

function createLiveTimelineEntry(input: {
  snapshot: ReplaySnapshot;
  previousGraph: SnitchGraph | undefined;
  generatedAt: string;
  source: string;
}): string {
  const diff = input.previousGraph ? diffGraph(input.previousGraph, input.snapshot.graph) : undefined;
  const entry: TimelineEntry = {
    snapshotId: input.snapshot.id,
    title: input.snapshot.title,
    description: input.snapshot.description,
    warningCount: input.snapshot.warnings.length,
    diffSummary: diff?.summary ?? {
      addedNodes: input.snapshot.graph.nodes.length,
      removedNodes: 0,
      changedNodes: 0,
      addedEdges: input.snapshot.graph.edges.length,
      removedEdges: 0,
      changedEdges: 0
    },
    generatedAt: input.generatedAt,
    source: input.source
  };

  if (input.previousGraph) {
    entry.previousSnapshotId = input.previousGraph.id;
  }

  return JSON.stringify(entry);
}

function appendTimelineEntry(existingTimeline: string, entry: string): string {
  const trimmed = existingTimeline.trimEnd();

  return trimmed ? `${trimmed}\n${entry}\n` : `${entry}\n`;
}

async function persistAnalysisTarget(
  cwd: string,
  target: string,
  now: Date,
  snapshotId: string
): Promise<void> {
  const storedTarget = storeTargetPath(cwd, target);

  try {
    const config = await readConfig(cwd);
    await writeJson(cwd, ".snitch/config.json", {
      ...config,
      analysis: {
        engine: "typescript",
        target: storedTarget,
        refreshOn: "file-event"
      }
    } satisfies SnitchConfig);
  } catch {
    await writeJson(cwd, ".snitch/config.json", {
      version: 1,
      project: basename(cwd) || "repo",
      mode: "background-companion",
      autoInject: true,
      includeFiles: true,
      artifactsDir: ".snitch",
      hookAdapter: hookFile,
      hookCommand: "node .snitch/hooks/codex-hook.mjs <hook-name>",
      agents: ["codex"],
      generatedConfigs: [],
      analysis: {
        engine: "typescript",
        target: storedTarget,
        refreshOn: "file-event"
      },
      createdAt: now.toISOString()
    } satisfies SnitchConfig);
  }

  try {
    const session = await readSession(cwd);
    const updatedSession: SnitchSession = {
      ...session,
      snapshotId,
      graphSource: "typescript",
      analysisTarget: storedTarget,
      lastAnalyzedAt: now.toISOString()
    };

    delete updatedSession.lastAnalysisError;
    await writeJson(cwd, ".snitch/session.json", updatedSession);
  } catch {
    // `snitch analyze` can be used as a standalone artifact generator before init.
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
  graphSource: GraphSource;
  analysisTarget: string;
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
    graphSource: input.graphSource,
    analysisTarget: input.analysisTarget,
    eventsPath: eventsFile,
    artifacts: [
      "graph.json",
      "warnings.json",
      "findings.json",
      "next-action.md",
      "timeline.jsonl",
      "mermaid.mmd",
      "handoff.md",
      "pr-comment.md"
    ]
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
const ingestUrl = process.env.SNITCH_INGEST_URL || "http://127.0.0.1:4767/api/events";
const liveResult = await postToLiveServer(ingestUrl, source, hook, input);

if (liveResult.ok) {
  if (liveResult.agentFeedback && process.env.SNITCH_PRINT_FEEDBACK !== "0") {
    process.stderr.write("\\n" + liveResult.agentFeedback + "\\n");
  }
  process.exit(0);
}

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

async function postToLiveServer(url, sourceName, hookName, body) {
  if (process.env.SNITCH_DISABLE_HTTP === "1") {
    return { ok: false, agentFeedback: "" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SNITCH_HTTP_TIMEOUT_MS || 350));

  try {
    const target = new URL(url);
    target.searchParams.set("source", sourceName);
    target.searchParams.set("hook", hookName);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));

    return {
      ok: response.ok,
      agentFeedback: typeof payload.agentFeedback === "string" ? payload.agentFeedback : ""
    };
  } catch {
    return { ok: false, agentFeedback: "" };
  } finally {
    clearTimeout(timeout);
  }
}
`;
}

async function writeAgentConfigs(cwd: string, agents: AgentTarget[]): Promise<void> {
  await Promise.all(
    agents.map(async (agent) => {
      if (agent === "codex") {
        await writeJson(cwd, ".codex/hooks.json", createCodexHooksConfig());
      }

      if (agent === "cursor") {
        await writeText(cwd, ".cursor/rules/snitch.mdc", createCursorRule());
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

function createCursorRule(): string {
  return `---
description: Use Snitch to verify AI-agent code changes with a live local system map.
alwaysApply: false
---

# Snitch local verification

Use Snitch when a task changes routes, tools, schemas, auth, permissions, external APIs, environment variables, database writes, tests, or agent-facing workflows.

- Run \`pnpm snitch analyze --target . --task "<current task>"\` after meaningful implementation changes.
- Run \`pnpm snitch doctor\` when you need to verify that Snitch is wired into this repo and coding-agent session.
- Run \`pnpm snitch check --target . --task "<current task>"\` before handing off risky changes.
- Run \`pnpm snitch insights --offline\` when provider credentials are unavailable.
- Run \`pnpm snitch next-action\` after Snitch captures a hook event to get the current grounded agent follow-up.
- Run \`pnpm snitch trace --warning <id>\` when you need to connect a warning to safe hook events and graph timeline evidence.
- Run \`pnpm snitch changed\` before handoff to focus warnings on the local Git changed surface.
- Run \`pnpm snitch repair-prompt\` when warnings are active, then implement the returned agent prompt.
- Run \`pnpm snitch finalize\` before preparing a pull request or handoff.
- Treat \`.snitch/graph.json\`, \`.snitch/warnings.json\`, \`.snitch/findings.json\`, \`.snitch/next-action.md\`, \`.snitch/mermaid.mmd\`, \`.snitch/pr-comment.md\`, and \`.snitch/handoff.md\` as generated evidence.
- Do not give the coding agent GitHub write access for Snitch publishing; publish artifacts through a separate workflow.
`;
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

async function resolveGitHooksDir(cwd: string): Promise<string> {
  const gitPath = resolve(cwd, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (gitStat.isDirectory()) {
      return resolve(gitPath, "hooks");
    }
  } catch {
    throw new Error("Cannot install Git hooks because .git was not found.");
  }

  const gitFile = await readFile(gitPath, "utf8");
  const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);

  if (!match?.[1]) {
    throw new Error(`Cannot resolve Git hooks directory from ${gitPath}.`);
  }

  return resolve(cwd, match[1].trim(), "hooks");
}

function createGitHookScript(hookName: GitHookName): string {
  const snitchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return `#!/usr/bin/env sh
# snitch-managed:${hookName}
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
payload='{"hook":"${hookName}","event":"git_${hookName.replaceAll("-", "_")}"}'

if command -v pnpm >/dev/null 2>&1; then
  printf '%s' "$payload" | pnpm --dir ${shellQuote(snitchRoot)} snitch event --cwd "$repo_root" --source git --hook "file_changed:${hookName}" >/dev/null 2>&1 || true
fi
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isSnitchManagedHook(contents: string): boolean {
  return contents.includes("# snitch-managed:");
}

function generatedConfigPaths(agents: AgentTarget[]): string[] {
  const paths: string[] = [];

  if (agents.includes("codex")) {
    paths.push(".codex/hooks.json");
  }

  if (agents.includes("cursor")) {
    paths.push(".cursor/rules/snitch.mdc");
  }

  if (agents.includes("claude")) {
    paths.push(".claude/settings.local.json");
  }

  if (agents.includes("opencode")) {
    paths.push(".opencode/snitch-plugin.ts");
  }

  return paths;
}

function shouldRefreshFromEvent(event: SnitchEvent): boolean {
  if (event.phase === "file_changed") {
    return true;
  }

  if (event.phase !== "tool_after") {
    return false;
  }

  const toolName = String(event.safeSummary.tool_name ?? event.safeSummary.tool ?? "").toLowerCase();
  const fileChangingTools = ["apply_patch", "edit", "multiedit", "write", "notebookedit"];

  if (fileChangingTools.some((tool) => toolName.includes(tool))) {
    return true;
  }

  return Boolean(event.evidence?.some((item) => looksLikeCodePath(item.file)));
}

function looksLikeCodePath(path: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(path);
}

function storeTargetPath(cwd: string, target: string): string {
  const resolvedTarget = isAbsolute(target) ? target : resolve(cwd, target);
  const relativeTarget = relative(cwd, resolvedTarget);

  if (!relativeTarget) {
    return ".";
  }

  if (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget)) {
    return relativeTarget;
  }

  return resolvedTarget;
}

function resolveStoredTarget(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

async function readConfig(cwd: string): Promise<SnitchConfig> {
  const contents = await readFile(resolve(cwd, ".snitch/config.json"), "utf8");
  const parsed = JSON.parse(contents) as SnitchConfig;

  if (!parsed.analysis) {
    return {
      ...parsed,
      analysis: {
        engine: "typescript",
        target: ".",
        refreshOn: "file-event"
      }
    };
  }

  return parsed;
}

async function readSession(cwd: string): Promise<SnitchSession> {
  const contents = await readFile(resolve(cwd, ".snitch/session.json"), "utf8");
  const parsed = JSON.parse(contents) as Partial<SnitchSession> & {
    createdAt?: string;
    reviewSnapshotId?: string;
  };
  const lastEventAt =
    parsed.lastEventAt ?? parsed.lastAnalyzedAt ?? parsed.createdAt ?? new Date(0).toISOString();
  const startedAt = parsed.startedAt ?? parsed.createdAt ?? lastEventAt;

  return {
    runId: parsed.runId ?? "snitch-unknown",
    task: parsed.task ?? defaultTask,
    status: parsed.status ?? "initialized",
    source: "snitch-background",
    startedAt,
    lastEventAt,
    eventCount: parsed.eventCount ?? 0,
    snapshotId: parsed.snapshotId ?? parsed.reviewSnapshotId ?? "unknown",
    graphSource: parsed.graphSource ?? "replay",
    analysisTarget: parsed.analysisTarget ?? ".",
    ...(parsed.lastAnalyzedAt ? { lastAnalyzedAt: parsed.lastAnalyzedAt } : {}),
    ...(parsed.lastAnalysisError ? { lastAnalysisError: parsed.lastAnalysisError } : {}),
    eventsPath: eventsFile,
    artifacts: parsed.artifacts ?? [
      "graph.json",
      "warnings.json",
      "findings.json",
      "next-action.md",
      "timeline.jsonl",
      "mermaid.mmd",
      "handoff.md",
      "pr-comment.md"
    ]
  };
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

async function readTimelineEntries(cwd: string): Promise<TimelineEntry[]> {
  try {
    const contents = await readFile(resolve(cwd, ".snitch/timeline.jsonl"), "utf8");

    return contents
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;

          return isTimelineEntry(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isTimelineEntry(value: unknown): value is TimelineEntry {
  if (!isRecord(value) || !isRecord(value.diffSummary)) {
    return false;
  }

  return (
    typeof value.snapshotId === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.warningCount === "number" &&
    typeof value.diffSummary.addedNodes === "number" &&
    typeof value.diffSummary.removedNodes === "number" &&
    typeof value.diffSummary.changedNodes === "number" &&
    typeof value.diffSummary.addedEdges === "number" &&
    typeof value.diffSummary.removedEdges === "number" &&
    typeof value.diffSummary.changedEdges === "number"
  );
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
  const agents = rawAgents.includes("all") ? ["codex", "cursor", "claude", "opencode"] : rawAgents;
  const validAgents = agents.filter(isAgentTarget);

  return validAgents.length > 0 ? unique(validAgents) : ["codex"];
}

function parsePort(value: string | true | undefined): number {
  if (!value || value === true) {
    return 4767;
  }

  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port < 65536 ? port : 4767;
}

function parseInterval(value: string | true | undefined): number {
  if (!value || value === true) {
    return 750;
  }

  const interval = Number(value);
  return Number.isInteger(interval) && interval >= 100 ? interval : 750;
}

function parseScanInterval(value: string | true | undefined): number {
  if (!value || value === true) {
    return 600;
  }

  const interval = Number(value);
  return Number.isInteger(interval) && interval >= 150 ? interval : 600;
}

function isAgentTarget(value: string): value is AgentTarget {
  return value === "codex" || value === "cursor" || value === "claude" || value === "opencode";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    "  snitch init [--cwd <repo>] [--agent codex|cursor|claude|opencode|all] [--target <ts-repo>] [--task <task>]",
    "  snitch event [--cwd <repo>] [--source <agent>] [--hook <hook>] < stdin-json",
    "  snitch analyze [--cwd <output-repo>] [--target <ts-repo>] [--task <task>]",
    "  snitch check [--cwd <output-repo>] [--target <ts-repo>] [--task <task>] [--fail-on info|low|medium|high] [--json]",
    "  snitch watch [--cwd <repo>] [--target <ts-repo>] [--port <port>] [--interval <ms>] [--scan-interval <ms>] [--no-files]",
    "  snitch insights [--cwd <repo>] [--offline]",
    "  snitch repair-prompt [--cwd <repo>] [--warning <id>] [--all]",
    "  snitch status [--cwd <repo>] [--json]",
    "  snitch doctor [--cwd <repo>] [--json]",
    "  snitch changed [--cwd <repo>] [--target <ts-repo>] [--json]",
    "  snitch trace [--cwd <repo>] [--warning <id>] [--json]",
    "  snitch impact [--cwd <repo>] [--warning <id>] [--json]",
    "  snitch findings [--cwd <repo>] [--json]",
    "  snitch next-action [--cwd <repo>] [--json]",
    "  snitch mcp [--cwd <repo>]",
    "  snitch finalize [--cwd <repo>]",
    "  snitch install-git-hooks [--cwd <repo>] [--force]",
    "  snitch publish-github [--cwd <repo>] [--repo owner/name] [--pr <number>] [--token <token>]"
  ].join("\n") + "\n";
}

function createRunId(now: Date): string {
  return `snitch-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}
