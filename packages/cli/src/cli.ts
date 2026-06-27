import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSnitchEvent, type SnitchEvent } from "@snitch/events";
import { extractTypeScriptGraph } from "@snitch/extractor-ts";
import {
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
  type RankedWarning,
  type ReplaySnapshot,
  type SnitchArtifacts,
  type SnitchGraph,
  type SnitchWarning,
  type IntegrationStatus
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
  artifacts: {
    mermaid: string;
    prComment: string;
    handoff: string;
    timeline: string;
  };
  insights?: InsightArtifact;
  memory?: MemoryArtifact;
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

type GitHubComment = {
  id: number;
  body?: string;
  html_url?: string;
};

type GitHubPublishOptions = {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  apiUrl: string;
  commentPath: string;
  marker: string;
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
      return ok(await readSnitchStatus(cwd));
    }

    if (command === "analyze") {
      const target = resolve(cwd, String(parsed.flags.get("target") ?? "."));
      const task = String(parsed.flags.get("task") ?? defaultTask);
      return ok(await analyzeTypeScriptRepo(cwd, target, task, now));
    }

    if (command === "watch") {
      const port = parsePort(parsed.flags.get("port"));
      const intervalMs = parseInterval(parsed.flags.get("interval"));
      const url = await startLiveServer(cwd, port, intervalMs);
      return ok(
        [
          "Snitch live server started.",
          `- URL: ${url}`,
          "- State: /api/state",
          "- Events: /api/events"
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

    if (command === "finalize") {
      const message = await finalizeSnitch(cwd, now);
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
    "- Updated: .snitch/graph.json, .snitch/mermaid.mmd, .snitch/pr-comment.md"
  ].join("\n") + "\n";
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

  return [
    `Snitch captured ${input.source}:${input.hook}.`,
    `- Events: ${nextEvents.length}`,
    `- Graph: ${graphUpdate.message}`,
    "- Updated: .snitch/graph.json, .snitch/mermaid.mmd, .snitch/pr-comment.md"
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

async function startLiveServer(cwd: string, port: number, intervalMs: number): Promise<string> {
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
      handleLiveEvents(cwd, response, intervalMs);
      request.on("close", () => response.end());
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return `http://127.0.0.1:${actualPort}`;
}

export async function readLiveState(cwd: string): Promise<LiveState> {
  const graph = JSON.parse(await readFile(resolve(cwd, ".snitch/graph.json"), "utf8")) as SnitchGraph;
  const warnings = await readWarnings(cwd, graph);
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
    artifacts: {
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
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readTextIfExists(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
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
        runId: input.session.runId
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
  }
): Promise<AnalysisWriteResult> {
  const analyzedAt = input.now.toISOString();
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

  return {
    snapshot: extracted.snapshot,
    graphSource: "typescript",
    target: storeTargetPath(cwd, input.target),
    analyzedAt
  };
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
- Run \`pnpm snitch insights --offline\` when provider credentials are unavailable.
- Run \`pnpm snitch finalize\` before preparing a pull request or handoff.
- Treat \`.snitch/graph.json\`, \`.snitch/warnings.json\`, \`.snitch/mermaid.mmd\`, \`.snitch/pr-comment.md\`, and \`.snitch/handoff.md\` as generated evidence.
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
  const parsed = JSON.parse(contents) as SnitchSession;

  return {
    ...parsed,
    graphSource: parsed.graphSource ?? "replay",
    analysisTarget: parsed.analysisTarget ?? "."
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

function isAgentTarget(value: string): value is AgentTarget {
  return value === "codex" || value === "cursor" || value === "claude" || value === "opencode";
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
    "  snitch init [--cwd <repo>] [--agent codex|cursor|claude|opencode|all] [--target <ts-repo>] [--task <task>]",
    "  snitch event [--cwd <repo>] [--source <agent>] [--hook <hook>] < stdin-json",
    "  snitch analyze [--cwd <output-repo>] [--target <ts-repo>] [--task <task>]",
    "  snitch watch [--cwd <repo>] [--port <port>] [--interval <ms>]",
    "  snitch insights [--cwd <repo>] [--offline]",
    "  snitch status [--cwd <repo>]",
    "  snitch finalize [--cwd <repo>]",
    "  snitch publish-github [--cwd <repo>] [--repo owner/name] [--pr <number>] [--token <token>]"
  ].join("\n") + "\n";
}

function createRunId(now: Date): string {
  return `snitch-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}
