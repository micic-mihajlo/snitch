export type NodeKind =
  | "agent"
  | "endpoint"
  | "schema"
  | "service"
  | "tool"
  | "env"
  | "external"
  | "database"
  | "test"
  | "contract"
  | "warning";

export type EdgeKind =
  | "calls"
  | "validates"
  | "reads"
  | "writes"
  | "uses_secret"
  | "covers"
  | "registers"
  | "satisfies"
  | "violates"
  | "missing";

export type WarningSeverity = "info" | "low" | "medium" | "high";

export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  file?: string;
  line?: number;
  meta?: Record<string, unknown>;
  hash: string;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  meta?: Record<string, unknown>;
  hash: string;
};

export type SnitchGraph = {
  id: string;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt?: string;
  meta?: Record<string, unknown>;
};

export type ChangedItem<T extends { id: string; hash: string }> = {
  id: string;
  previous: T;
  next: T;
};

export type GraphDiff = {
  addedNodes: GraphNode[];
  removedNodes: GraphNode[];
  changedNodes: ChangedItem<GraphNode>[];
  unchangedNodes: GraphNode[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
  changedEdges: ChangedItem<GraphEdge>[];
  unchangedEdges: GraphEdge[];
  summary: {
    addedNodes: number;
    removedNodes: number;
    changedNodes: number;
    addedEdges: number;
    removedEdges: number;
    changedEdges: number;
  };
};

export type SnitchWarning = {
  id: string;
  kind: "warning";
  severity: WarningSeverity;
  title: string;
  message: string;
  evidence: string[];
  repairPrompt?: string;
};

export type GraphUpdate =
  | {
      ok: true;
      source: string;
      graph: SnitchGraph;
    }
  | {
      ok: false;
      source: string;
      error: string;
    };

export type GraphUpdateResult = {
  accepted: boolean;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
};

export type ReplaySnapshot = {
  id: string;
  title: string;
  description: string;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
};

export type SnitchArtifactInput = {
  replay: ReplaySnapshot[];
  reviewSnapshot: ReplaySnapshot;
  createdAt: string;
  runId: string;
  task: string;
};

export type SnitchArtifacts = {
  "session.json": string;
  "graph.json": string;
  "timeline.jsonl": string;
  "mermaid.mmd": string;
  "handoff.md": string;
  "pr-comment.md": string;
};
