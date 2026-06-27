import { diffGraph, hashEvidence } from "./diff";
import type { EdgeKind, GraphDiff, GraphEdge, GraphNode, NodeKind, ReplaySnapshot, SnitchGraph, SnitchWarning } from "./types";

export type CerebrasMessage = {
  role: "system" | "user";
  content: string;
};

export type CerebrasNarrationInput = {
  messages: CerebrasMessage[];
};

export type CerebrasWarningTriageInput = {
  messages: CerebrasMessage[];
};

export type CerebrasDiagramInput = {
  messages: CerebrasMessage[];
};

export type CerebrasNarrationOptions = {
  apiKey?: string;
  model: string;
  input: CerebrasNarrationInput;
  fetcher?: typeof fetch;
};

export type IntegrationStatus = "ok" | "disabled" | "fallback";

export type CerebrasNarrationResult = {
  status: IntegrationStatus;
  text: string;
  model?: string;
};

export type WarningPriority = "critical" | "high" | "medium" | "low";

export type RankedWarning = {
  warningId: string;
  rank: number;
  priority: WarningPriority;
  reason: string;
  repairPrompt: string;
};

export type CerebrasWarningTriageResult = {
  status: IntegrationStatus;
  rankedWarnings: RankedWarning[];
  model?: string;
};

export type CerebrasDiagramResult = {
  status: IntegrationStatus;
  graph: SnitchGraph;
  summary: string;
  model?: string;
};

export type BackboardRuleResult = {
  status: IntegrationStatus;
  rules: string[];
};

export type BackboardDecisionResult = {
  status: IntegrationStatus;
};

export function createCerebrasNarrationInput(input: {
  task: string;
  diff: GraphDiff;
  warnings: SnitchWarning[];
  repoRules: string[];
}): CerebrasNarrationInput {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are Snitch's fast semantic lane. Explain graph diffs tersely. Do not invent graph facts."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.task,
            diffSummary: input.diff.summary,
            addedNodes: input.diff.addedNodes.map((node) => ({ id: node.id, label: node.label })),
            changedNodes: input.diff.changedNodes.map((change) => ({
              id: change.id,
              previousHash: change.previous.hash,
              nextHash: change.next.hash
            })),
            warnings: input.warnings.map((warning) => ({
              id: warning.id,
              title: warning.title,
              severity: warning.severity,
              evidence: warning.evidence
            })),
            repoRules: input.repoRules
          },
          null,
          2
        )
      }
    ]
  };
}

export function createCerebrasWarningTriageInput(input: {
  task: string;
  warnings: SnitchWarning[];
  repoRules: string[];
}): CerebrasWarningTriageInput {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are Snitch's warning triage lane. Rank warnings for developer action. Return strict JSON only."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.task,
            expectedShape: {
              rankedWarnings: [
                {
                  warningId: "string",
                  rank: 1,
                  priority: "critical | high | medium | low",
                  reason: "short reason grounded in warning evidence",
                  repairPrompt: "one concrete repair instruction"
                }
              ]
            },
            warnings: input.warnings.map((warning) => ({
              id: warning.id,
              title: warning.title,
              severity: warning.severity,
              message: warning.message,
              evidence: warning.evidence,
              repairPrompt: warning.repairPrompt
            })),
            repoRules: input.repoRules
          },
          null,
          2
        )
      }
    ]
  };
}

export function createCerebrasDiagramInput(input: {
  task: string;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
  repoRules: string[];
  changedFiles?: Array<{ path: string; status: string; targetPath?: string }>;
}): CerebrasDiagramInput {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are Snitch's ultra-fast diagram lane. Create a compact developer-facing architecture diagram from provided graph facts. Return strict JSON only. Never invent node ids, files, warnings, or edges."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.task,
            expectedShape: {
              title: "short title",
              summary: "one sentence explaining what changed or what matters",
              nodes: [
                {
                  id: "must be one of graph.nodes[].id",
                  label: "short label, preferably existing label"
                }
              ],
              edges: [
                {
                  from: "must be one of selected node ids",
                  to: "must be one of selected node ids",
                  kind: "must match an existing edge kind between from and to"
                }
              ]
            },
            limits: {
              nodes: 8,
              edges: 12
            },
            graph: {
              title: input.graph.title,
              nodes: input.graph.nodes.map((node) => ({
                id: node.id,
                kind: node.kind,
                label: node.label,
                file: node.file,
                line: node.line
              })),
              edges: input.graph.edges.map((edge) => ({
                from: edge.from,
                to: edge.to,
                kind: edge.kind,
                label: edge.label
              }))
            },
            warnings: input.warnings.map((warning) => ({
              id: warning.id,
              severity: warning.severity,
              title: warning.title,
              evidence: warning.evidence
            })),
            changedFiles: input.changedFiles ?? [],
            repoRules: input.repoRules
          },
          null,
          2
        )
      }
    ]
  };
}

export async function narrateWithCerebras(
  options: CerebrasNarrationOptions
): Promise<CerebrasNarrationResult> {
  if (!options.apiKey?.trim()) {
    return {
      status: "disabled",
      text: "Cerebras is not configured, so Snitch is using static narration."
    };
  }

  const fallbackText = createStaticNarrationFromInput(options.input);

  try {
    const response = await (options.fetcher ?? fetch)("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.input.messages,
        max_completion_tokens: cerebrasMaxCompletionTokens(options.model, 180, 2000),
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Cerebras responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new Error("Cerebras returned an empty completion");
    }

    return {
      status: "ok",
      text,
      model: options.model
    };
  } catch {
    return {
      status: "fallback",
      text: fallbackText,
      model: options.model
    };
  }
}

export async function rankWarningsWithCerebras(options: {
  apiKey?: string;
  model: string;
  input: CerebrasWarningTriageInput;
  warnings: SnitchWarning[];
  fetcher?: typeof fetch;
}): Promise<CerebrasWarningTriageResult> {
  const fallbackRankings = createFallbackWarningRankings(options.warnings);

  if (!options.apiKey?.trim()) {
    return {
      status: "disabled",
      rankedWarnings: fallbackRankings
    };
  }

  try {
    const response = await (options.fetcher ?? fetch)("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.input.messages,
        max_completion_tokens: cerebrasMaxCompletionTokens(options.model, 500, 3000),
        response_format: { type: "json_object" },
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`Cerebras responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const rankedWarnings = parseRankedWarnings(content, options.warnings);

    if (rankedWarnings.length === 0 && options.warnings.length > 0) {
      throw new Error("Cerebras returned no ranked warnings");
    }

    return {
      status: "ok",
      rankedWarnings,
      model: options.model
    };
  } catch {
    return {
      status: "fallback",
      rankedWarnings: fallbackRankings,
      model: options.model
    };
  }
}

export async function diagramWithCerebras(options: {
  apiKey?: string;
  model: string;
  input: CerebrasDiagramInput;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
  fetcher?: typeof fetch;
}): Promise<CerebrasDiagramResult> {
  const fallback = createFallbackDiagram(options.graph, options.warnings);

  if (!options.apiKey?.trim()) {
    return {
      status: "disabled",
      ...fallback
    };
  }

  try {
    const response = await (options.fetcher ?? fetch)("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.input.messages,
        max_completion_tokens: cerebrasMaxCompletionTokens(options.model, 700, 3000),
        response_format: { type: "json_object" },
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`Cerebras responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = parseDiagramGraph(payload.choices?.[0]?.message?.content, options.graph);

    if (!parsed.graph.nodes.length) {
      throw new Error("Cerebras returned an empty diagram");
    }

    return {
      status: "ok",
      model: options.model,
      ...parsed
    };
  } catch {
    return {
      status: "fallback",
      model: options.model,
      ...fallback
    };
  }
}

function cerebrasMaxCompletionTokens(model: string, standard: number, reasoning: number): number {
  return model.toLowerCase().includes("glm") ? reasoning : standard;
}

export function createStaticNarration(diff: GraphDiff, warnings: SnitchWarning[]): string {
  const warningText =
    warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"} need review.`
      : "No active warnings.";

  return `Snitch saw ${diff.summary.addedNodes} added node${diff.summary.addedNodes === 1 ? "" : "s"}, ${diff.summary.changedNodes} changed node${diff.summary.changedNodes === 1 ? "" : "s"}, and ${diff.summary.addedEdges} added edge${diff.summary.addedEdges === 1 ? "" : "s"}. ${warningText}`;
}

export function createFallbackWarningRankings(warnings: SnitchWarning[]): RankedWarning[] {
  const severityWeight: Record<SnitchWarning["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3
  };

  return [...warnings]
    .sort((left, right) => severityWeight[left.severity] - severityWeight[right.severity])
    .map((warning, index) => ({
      warningId: warning.id,
      rank: index + 1,
      priority: severityToPriority(warning.severity),
      reason: warning.message,
      repairPrompt: warning.repairPrompt ?? `Repair ${warning.title}.`
    }));
}

export function createFallbackDiagram(graph: SnitchGraph, warnings: SnitchWarning[]): {
  graph: SnitchGraph;
  summary: string;
} {
  const warningIds = new Set(warnings.map((warning) => warning.id));
  const selected = new Set<string>();
  const actorIds = new Set<string>();

  // 1. The findings themselves, kept so a collapsed map can still badge their actor.
  for (const node of graph.nodes) {
    if (node.kind === "warning" && warningIds.has(node.id)) {
      selected.add(node.id);
    }
  }

  // 2. The actors the findings sit on (the flagged tools / routes).
  for (const edge of graph.edges) {
    if (selected.has(edge.from) && !warningIds.has(edge.to)) {
      actorIds.add(edge.to);
    }
    if (selected.has(edge.to) && !warningIds.has(edge.from)) {
      actorIds.add(edge.from);
    }
  }
  for (const id of actorIds) {
    selected.add(id);
  }

  // 3. The real architecture each actor reaches — external systems, secrets, services —
  //    so the map shows WHY it is flagged instead of a single lonely node.
  for (const edge of graph.edges) {
    if (actorIds.has(edge.from)) {
      selected.add(edge.to);
    }
    if (actorIds.has(edge.to)) {
      selected.add(edge.from);
    }
  }

  const selectedIds = selected.size > 0 ? selected : fallbackImportantNodeIds(graph);
  const nodes = graph.nodes
    .filter((node) => selectedIds.has(node.id))
    .sort((left, right) => diagramNodePriority(left, actorIds) - diagramNodePriority(right, actorIds))
    .slice(0, 12);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .slice(0, 16);

  const scopedGraph: SnitchGraph = {
    id: `${graph.id}:diagram`,
    title: "Cerebras diagram fallback",
    meta: {
      sourceGraphId: graph.id
    },
    nodes,
    edges
  };

  if (graph.generatedAt) {
    scopedGraph.generatedAt = graph.generatedAt;
  }

  return {
    summary:
      warnings.length > 0
        ? `${warnings.length} active warning${warnings.length === 1 ? "" : "s"} around the current change.`
        : "Changed files have no active Snitch findings; showing the most connected services and tools.",
    graph: scopedGraph
  };
}

// Keep the flagged actor and its real architecture neighbors when capping the diagram;
// warning nodes collapse into badges in the UI, so they are the first to drop if truncated.
function diagramNodePriority(node: GraphNode, actorIds: Set<string>): number {
  if (actorIds.has(node.id)) {
    return 0;
  }

  return node.kind === "warning" ? 2 : 1;
}

function fallbackImportantNodeIds(graph: SnitchGraph): Set<string> {
  const degree = new Map<string, number>();

  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  return new Set(
    [...graph.nodes]
      .sort((left, right) =>
        fallbackNodeRank(left) - fallbackNodeRank(right) ||
        (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, 6)
      .map((node) => node.id)
  );
}

function fallbackNodeRank(node: GraphNode): number {
  const ranks: Record<NodeKind, number> = {
    service: 0,
    tool: 1,
    external: 2,
    contract: 3,
    schema: 4,
    endpoint: 5,
    database: 6,
    agent: 7,
    warning: 8,
    test: 9,
    env: 10
  };

  return ranks[node.kind];
}

export async function loadBackboardRepoRules(input: {
  apiKey?: string;
  assistantId?: string;
  task: string;
  fetcher?: typeof fetch;
}): Promise<BackboardRuleResult> {
  if (!input.apiKey?.trim()) {
    return { status: "disabled", rules: [] };
  }

  try {
    const response = await (input.fetcher ?? fetch)("https://app.backboard.io/api/threads/messages", {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: `Return repo rules relevant to this Snitch task. Prefix each rule with RULE:. Task: ${input.task}`,
        stream: false,
        memory: "Readonly",
        ...(input.assistantId ? { assistant_id: input.assistantId } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Backboard responded with ${response.status}`);
    }

    const payload = (await response.json()) as { content?: string; message?: string };
    return {
      status: "ok",
      rules: extractRules(payload.content ?? payload.message ?? "")
    };
  } catch {
    return { status: "fallback", rules: [] };
  }
}

export async function rememberBackboardWarningDecision(input: {
  apiKey?: string;
  assistantId?: string;
  warning: SnitchWarning;
  decision: "accepted" | "dismissed" | "repaired";
  fetcher?: typeof fetch;
}): Promise<BackboardDecisionResult> {
  if (!input.apiKey?.trim()) {
    return { status: "disabled" };
  }

  try {
    const response = await (input.fetcher ?? fetch)("https://app.backboard.io/api/threads/messages", {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({
          type: "snitch_warning_decision",
          decision: input.decision,
          warningId: input.warning.id,
          severity: input.warning.severity,
          title: input.warning.title,
          evidenceHashes: input.warning.evidence.map((evidence) => hashEvidence(evidence))
        }),
        stream: false,
        memory: "Auto",
        ...(input.assistantId ? { assistant_id: input.assistantId } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Backboard responded with ${response.status}`);
    }

    return { status: "ok" };
  } catch {
    return { status: "fallback" };
  }
}

export function createNarrationForSnapshot(input: {
  previous: ReplaySnapshot;
  next: ReplaySnapshot;
  task: string;
  repoRules: string[];
}): CerebrasNarrationInput {
  return createCerebrasNarrationInput({
    task: input.task,
    diff: diffGraph(input.previous.graph, input.next.graph),
    warnings: input.next.warnings,
    repoRules: input.repoRules
  });
}

function createStaticNarrationFromInput(input: CerebrasNarrationInput): string {
  const content = input.messages.find((message) => message.role === "user")?.content ?? "{}";
  const parsed = parseNarrationInput(content);

  return createStaticNarration(
    {
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
      unchangedNodes: [],
      addedEdges: [],
      removedEdges: [],
      changedEdges: [],
      unchangedEdges: [],
      summary: parsed.diffSummary ?? {
        addedNodes: 0,
        removedNodes: 0,
        changedNodes: 0,
        addedEdges: 0,
        removedEdges: 0,
        changedEdges: 0
      }
    },
    parsed.warnings ?? []
  );
}

function parseNarrationInput(content: string): {
  diffSummary?: GraphDiff["summary"];
  warnings?: SnitchWarning[];
} {
  try {
    return JSON.parse(content) as {
      diffSummary?: GraphDiff["summary"];
      warnings?: SnitchWarning[];
    };
  } catch {
    return {};
  }
}

function parseRankedWarnings(content: string | undefined, warnings: SnitchWarning[]): RankedWarning[] {
  if (!content) {
    return [];
  }

  const warningIds = new Set(warnings.map((warning) => warning.id));
  const fallbackById = new Map(createFallbackWarningRankings(warnings).map((ranking) => [ranking.warningId, ranking]));
  const parsed = parseJsonObject(extractJson(content)) as {
    rankedWarnings?: Array<Partial<RankedWarning>>;
  };
  const rankedWarnings = Array.isArray(parsed.rankedWarnings) ? parsed.rankedWarnings : [];
  const result: RankedWarning[] = [];
  const seen = new Set<string>();

  for (const item of rankedWarnings) {
    if (typeof item.warningId !== "string" || !warningIds.has(item.warningId) || seen.has(item.warningId)) {
      continue;
    }

    const fallback = fallbackById.get(item.warningId);
    const rank = typeof item.rank === "number" && Number.isFinite(item.rank) ? item.rank : result.length + 1;
    const priority = isWarningPriority(item.priority) ? item.priority : fallback?.priority ?? "medium";
    const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : fallback?.reason ?? "";
    const repairPrompt =
      typeof item.repairPrompt === "string" && item.repairPrompt.trim()
        ? item.repairPrompt.trim()
        : fallback?.repairPrompt ?? "";

    result.push({
      warningId: item.warningId,
      rank,
      priority,
      reason,
      repairPrompt
    });
    seen.add(item.warningId);
  }

  for (const fallback of fallbackById.values()) {
    if (!seen.has(fallback.warningId)) {
      result.push({
        ...fallback,
        rank: result.length + 1
      });
    }
  }

  return result.sort((left, right) => left.rank - right.rank);
}

function parseDiagramGraph(content: string | undefined, sourceGraph: SnitchGraph): {
  graph: SnitchGraph;
  summary: string;
} {
  const parsed = parseJsonObject(extractJson(content ?? "")) as {
    title?: unknown;
    summary?: unknown;
    nodes?: Array<{ id?: unknown; label?: unknown }>;
    edges?: Array<{ from?: unknown; to?: unknown; kind?: unknown; label?: unknown }>;
  };
  const sourceNodeById = new Map(sourceGraph.nodes.map((node) => [node.id, node]));
  const sourceEdgeKeys = new Set(sourceGraph.edges.map((edge) => diagramEdgeKey(edge.from, edge.to, edge.kind)));
  const nodes: GraphNode[] = [];
  const selectedIds = new Set<string>();

  for (const item of Array.isArray(parsed.nodes) ? parsed.nodes : []) {
    if (typeof item.id !== "string" || selectedIds.has(item.id)) {
      continue;
    }

    const sourceNode = sourceNodeById.get(item.id);

    if (!sourceNode) {
      continue;
    }

    const label = typeof item.label === "string" && item.label.trim()
      ? item.label.trim()
      : sourceNode.label;
    nodes.push({
      ...sourceNode,
      label,
      hash: hashEvidence(JSON.stringify({ id: sourceNode.id, label, hash: sourceNode.hash }))
    });
    selectedIds.add(item.id);

    if (nodes.length >= 8) {
      break;
    }
  }

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const item of Array.isArray(parsed.edges) ? parsed.edges : []) {
    if (
      typeof item.from !== "string" ||
      typeof item.to !== "string" ||
      typeof item.kind !== "string" ||
      !selectedIds.has(item.from) ||
      !selectedIds.has(item.to) ||
      !isEdgeKind(item.kind)
    ) {
      continue;
    }

    const key = diagramEdgeKey(item.from, item.to, item.kind);

    if (!sourceEdgeKeys.has(key) || seenEdges.has(key)) {
      continue;
    }

    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined;
    const edge: GraphEdge = {
      id: `diagram:${item.from}:${item.kind}:${item.to}`,
      from: item.from,
      to: item.to,
      kind: item.kind,
      hash: hashEvidence(JSON.stringify({ from: item.from, to: item.to, kind: item.kind, label }))
    };

    if (label) {
      edge.label = label;
    }

    edges.push(edge);
    seenEdges.add(key);

    if (edges.length >= 12) {
      break;
    }
  }

  return {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Cerebras selected the most relevant graph path.",
    graph: {
      id: `${sourceGraph.id}:cerebras-diagram`,
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim()
          : "Cerebras diagram",
      generatedAt: new Date().toISOString(),
      meta: {
        sourceGraphId: sourceGraph.id
      },
      nodes,
      edges
    }
  };
}

function diagramEdgeKey(from: string, to: string, kind: EdgeKind): string {
  return `${from}\u0000${kind}\u0000${to}`;
}

function isEdgeKind(value: string): value is EdgeKind {
  return [
    "calls",
    "validates",
    "reads",
    "writes",
    "uses_secret",
    "covers",
    "registers",
    "satisfies",
    "violates",
    "missing"
  ].includes(value);
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() ?? content.trim();
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return {};
  }
}

function severityToPriority(severity: SnitchWarning["severity"]): WarningPriority {
  if (severity === "high") {
    return "high";
  }

  if (severity === "medium") {
    return "medium";
  }

  return "low";
}

function isWarningPriority(value: unknown): value is WarningPriority {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function extractRules(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toUpperCase().startsWith("RULE:"))
    .map((line) => line.slice(line.indexOf(":") + 1).trim())
    .filter(Boolean);
}
