import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import { useCallback, useMemo } from "react";
import type { GraphNode, SnitchGraph } from "@snitch/graph";

export type NodeFindingCount = { count: number; severity: string };

type Props = {
  graph: SnitchGraph;
  selectedNodeId?: string | undefined;
  onSelectNode?: (node: GraphNode) => void;
  cwd?: string | undefined;
  // Authoritative finding count per real node id, from the full warning set. Keeps badges
  // accurate even when the diagram lens truncates which warning nodes it carries.
  findingCounts?: Map<string, NodeFindingCount> | undefined;
};

// Left-to-right architecture layers: who acts on the left, what they reach on the right.
// Findings are NOT drawn as their own nodes anymore — they ride as a badge on the real node
// that is missing its companion, so the map reads as an architecture diagram, not a wall of
// red boxes.
function layerForNode(node: GraphNode): number {
  switch (node.kind) {
    case "agent":
      return 0;
    case "service":
      return node.meta?.role ? 4 : 1;
    case "tool":
    case "endpoint":
      return 2;
    case "schema":
    case "env":
    case "database":
      return 3;
    case "external":
    case "contract":
    case "test":
      return 4;
    default:
      return 2;
  }
}

const kindLabels: Record<string, string> = {
  agent: "agent",
  service: "service",
  tool: "tool",
  endpoint: "route",
  schema: "schema",
  env: "secret",
  database: "data",
  external: "external",
  contract: "contract",
  test: "test"
};

type SystemNodeData = {
  label: string;
  kind: GraphNode["kind"];
  file?: string;
  line?: number;
  editorHref?: string;
  findingCount: number;
  findingSeverity?: string;
  dimmed: boolean;
  emphasized: boolean;
};

function SystemNode({ data }: NodeProps<Node<SystemNodeData>>) {
  const classes = [
    "sys-node",
    `sys-node-${data.kind}`,
    data.findingCount > 0 ? "sys-node-flagged" : "",
    data.dimmed ? "sys-node-dim" : "",
    data.emphasized ? "sys-node-on" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} title={data.file ? `${data.file}${data.line ? `:${data.line}` : ""}` : data.label}>
      <Handle type="target" position={Position.Left} />
      {data.findingCount > 0 ? (
        <span
          className={data.findingSeverity === "medium" ? "node-badge badge-medium" : "node-badge"}
          title={`${data.findingCount} finding${data.findingCount === 1 ? "" : "s"} on this node`}
        >
          {data.findingCount}
        </span>
      ) : null}
      <span className="sys-node-kind">{kindLabels[data.kind] ?? data.kind}</span>
      <span className="sys-node-label">{data.label}</span>
      {data.file ? (
        data.editorHref ? (
          <a className="sys-node-file" href={data.editorHref} onClick={(event) => event.stopPropagation()}>
            {data.file}
            {data.line ? `:${data.line}` : ""}
          </a>
        ) : (
          <span className="sys-node-file">
            {data.file}
            {data.line ? `:${data.line}` : ""}
          </span>
        )
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { system: SystemNode };

export function GraphCanvas({ graph, selectedNodeId, onSelectNode, cwd, findingCounts }: Props) {
  // Split warning nodes out of the rendered graph and fold them into per-node finding badges.
  const collapsed = useMemo(() => collapseWarnings(graph), [graph]);
  const { realNodes, realEdges } = collapsed;
  // Prefer the authoritative counts from the full warning set; fall back to whatever warning
  // nodes this (possibly truncated) graph still carries.
  const badgeCounts = findingCounts && findingCounts.size > 0 ? findingCounts : collapsed.findingsByNode;

  // Selection can arrive as a warning id (from the Findings list) or a real node id (from a
  // map click). Resolve either to the real node we actually draw, so highlighting is stable.
  const activeId = useMemo(
    () => resolveActiveId(selectedNodeId, realNodes, graph),
    [selectedNodeId, realNodes, graph]
  );
  const neighborhood = useMemo(() => relatedNodeIds(realEdges, activeId), [realEdges, activeId]);

  const nodes = useMemo<Node<SystemNodeData>[]>(
    () => layoutNodes(realNodes, badgeCounts, neighborhood, activeId, cwd),
    [realNodes, badgeCounts, neighborhood, activeId, cwd]
  );

  const edges = useMemo<Edge[]>(
    () =>
      realEdges.map((edge) => {
        const onPath = activeId ? edge.from === activeId || edge.to === activeId : false;
        const showLabel = realEdges.length <= 20 || onPath;
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          label: showLabel ? edge.kind : undefined,
          className: [`edge-${edge.kind}`, activeId && !onPath ? "edge-dim" : "", onPath ? "edge-on" : ""]
            .filter(Boolean)
            .join(" ")
        };
      }),
    [realEdges, activeId]
  );

  const nodeById = useMemo(() => new Map(realNodes.map((node) => [node.id, node])), [realNodes]);
  // Re-fit only when the set of drawn nodes actually changes (not on every live poll), so a
  // diagram that grows from one node to a few re-centers instead of leaving them off-frame.
  const fitKey = useMemo(() => realNodes.map((node) => node.id).sort().join("|"), [realNodes]);

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      const source = nodeById.get(node.id);
      if (source && onSelectNode) {
        onSelectNode(source);
      }
    },
    [nodeById, onSelectNode]
  );

  return (
    <div className="graph-frame" data-testid="graph-frame">
      <ReactFlow
        key={fitKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
      >
        <Background gap={24} color="rgba(237, 237, 238, 0.06)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

type CollapsedGraph = {
  realNodes: GraphNode[];
  realEdges: SnitchGraph["edges"];
  findingsByNode: Map<string, { count: number; severity: string }>;
};

function collapseWarnings(graph: SnitchGraph): CollapsedGraph {
  const warningSeverity = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "warning") {
      const severity = typeof node.meta?.severity === "string" ? node.meta.severity : "high";
      warningSeverity.set(node.id, severity);
    }
  }

  const realNodes = graph.nodes.filter((node) => node.kind !== "warning");
  const realIds = new Set(realNodes.map((node) => node.id));
  const realEdges = graph.edges.filter((edge) => realIds.has(edge.from) && realIds.has(edge.to));

  // Attach each warning to the real nodes it touches.
  const findingsByNode = new Map<string, { count: number; severity: string }>();
  const severityWeight: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

  for (const edge of graph.edges) {
    const warningId = warningSeverity.has(edge.from)
      ? edge.from
      : warningSeverity.has(edge.to)
        ? edge.to
        : undefined;
    if (!warningId) {
      continue;
    }
    const realId = warningId === edge.from ? edge.to : edge.from;
    if (!realIds.has(realId)) {
      continue;
    }
    const severity = warningSeverity.get(warningId) ?? "high";
    const current = findingsByNode.get(realId);
    if (!current) {
      findingsByNode.set(realId, { count: 1, severity });
    } else {
      const worst = (severityWeight[severity] ?? 9) < (severityWeight[current.severity] ?? 9) ? severity : current.severity;
      findingsByNode.set(realId, { count: current.count + 1, severity: worst });
    }
  }

  return { realNodes, realEdges, findingsByNode };
}

function resolveActiveId(
  selectedNodeId: string | undefined,
  realNodes: GraphNode[],
  graph: SnitchGraph
): string | undefined {
  if (!selectedNodeId) {
    return undefined;
  }
  if (realNodes.some((node) => node.id === selectedNodeId)) {
    return selectedNodeId;
  }
  // selectedNodeId is a warning id: focus the real node it sits on.
  const realIds = new Set(realNodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (edge.from === selectedNodeId && realIds.has(edge.to)) {
      return edge.to;
    }
    if (edge.to === selectedNodeId && realIds.has(edge.from)) {
      return edge.from;
    }
  }
  return undefined;
}

function relatedNodeIds(edges: SnitchGraph["edges"], activeId: string | undefined): Set<string> | undefined {
  if (!activeId) {
    return undefined;
  }

  const related = new Set<string>([activeId]);
  let frontier = new Set<string>([activeId]);

  for (let depth = 0; depth < 2; depth += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.from) && !related.has(edge.to)) {
        related.add(edge.to);
        next.add(edge.to);
      }
      if (frontier.has(edge.to) && !related.has(edge.from)) {
        related.add(edge.from);
        next.add(edge.from);
      }
    }
    frontier = next;
  }

  return related;
}

function layoutNodes(
  nodes: GraphNode[],
  findingsByNode: Map<string, { count: number; severity: string }>,
  neighborhood: Set<string> | undefined,
  activeId: string | undefined,
  cwd: string | undefined
): Node<SystemNodeData>[] {
  const byLayer = new Map<number, GraphNode[]>();

  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const layer = layerForNode(node);
    const bucket = byLayer.get(layer) ?? [];
    bucket.push(node);
    byLayer.set(layer, bucket);
  }

  const rowGap = 104;
  const columnGap = 260;
  const tallest = Math.max(1, ...[...byLayer.values()].map((bucket) => bucket.length));
  const canvasHeight = tallest * rowGap;

  const positioned: Node<SystemNodeData>[] = [];

  for (const layer of [...byLayer.keys()].sort((left, right) => left - right)) {
    const bucket = byLayer.get(layer) ?? [];
    const columnHeight = bucket.length * rowGap;
    const offsetY = (canvasHeight - columnHeight) / 2;

    bucket.forEach((node, index) => {
      const finding = findingsByNode.get(node.id);
      const data: SystemNodeData = {
        label: node.label,
        kind: node.kind,
        findingCount: finding?.count ?? 0,
        dimmed: Boolean(neighborhood) && !neighborhood?.has(node.id),
        emphasized: activeId === node.id
      };

      if (node.file) {
        data.file = node.file;
      }
      if (typeof node.line === "number") {
        data.line = node.line;
      }
      if (finding) {
        data.findingSeverity = finding.severity;
      }
      const editorHref = buildEditorHref(cwd, node.file, node.line);
      if (editorHref) {
        data.editorHref = editorHref;
      }

      positioned.push({
        id: node.id,
        type: "system",
        position: { x: layer * columnGap, y: offsetY + index * rowGap },
        data,
        draggable: false
      });
    });
  }

  return positioned;
}

// VS Code / Cursor understand vscode://file/<abs-path>:<line>, so a node's anchor opens
// straight in the editor when the live server tells us the repo root.
function buildEditorHref(cwd: string | undefined, file: string | undefined, line: number | undefined): string | undefined {
  if (!cwd || !file) {
    return undefined;
  }

  const absolute = `${cwd.replace(/\/$/, "")}/${file}`;
  return `vscode://file/${absolute}${typeof line === "number" ? `:${line}` : ""}`;
}
