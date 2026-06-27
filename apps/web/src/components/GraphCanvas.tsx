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
import { useCallback, useMemo, useState } from "react";
import type { GraphNode, SnitchGraph } from "@snitch/graph";

type Props = {
  graph: SnitchGraph;
  selectedNodeId?: string | undefined;
  onSelectNode?: (node: GraphNode) => void;
  cwd?: string | undefined;
};

// Left-to-right architecture layers, ilograph style: who acts on the left, what they reach
// on the right, and the safeguards/gaps furthest right.
function layerForNode(node: GraphNode): number {
  switch (node.kind) {
    case "agent":
      return 0;
    case "service":
      // Plain services (registries, dispatchers) sit early; role-tagged safeguards
      // (audit/redaction) belong with the other guardrails on the right.
      return node.meta?.role ? 4 : 1;
    case "tool":
    case "endpoint":
      return 2;
    case "schema":
    case "env":
    case "database":
      return 3;
    case "external":
      return 4;
    case "contract":
    case "test":
      return 4;
    case "warning":
      return 5;
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
  test: "test",
  warning: "warning"
};

type SystemNodeData = {
  label: string;
  kind: GraphNode["kind"];
  file?: string;
  line?: number;
  severity?: string;
  editorHref?: string;
  dimmed: boolean;
  emphasized: boolean;
};

function SystemNode({ data }: NodeProps<Node<SystemNodeData>>) {
  const classes = [
    "sys-node",
    `sys-node-${data.kind}`,
    data.dimmed ? "sys-node-dim" : "",
    data.emphasized ? "sys-node-on" : "",
    data.severity ? `sys-node-sev-${data.severity}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} title={data.file ? `${data.file}${data.line ? `:${data.line}` : ""}` : data.label}>
      <Handle type="target" position={Position.Left} />
      <span className="sys-node-kind">{kindLabels[data.kind] ?? data.kind}</span>
      <span className="sys-node-label">{data.label}</span>
      {data.file ? (
        data.editorHref ? (
          <a
            className="sys-node-file"
            href={data.editorHref}
            onClick={(event) => event.stopPropagation()}
          >
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

export function GraphCanvas({ graph, selectedNodeId, onSelectNode, cwd }: Props) {
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined);
  const activeId = hoveredId ?? selectedNodeId;

  const neighborhood = useMemo(() => relatedNodeIds(graph, activeId), [graph, activeId]);

  const nodes = useMemo<Node<SystemNodeData>[]>(
    () => layoutNodes(graph.nodes, neighborhood, activeId, cwd),
    [graph.nodes, neighborhood, activeId, cwd]
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const onPath = activeId ? edge.from === activeId || edge.to === activeId : false;
        const showLabel = graph.edges.length <= 24 || onPath;
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          label: showLabel ? edge.kind : undefined,
          animated: edge.kind === "missing" || edge.kind === "calls",
          className: [`edge-${edge.kind}`, activeId && !onPath ? "edge-dim" : "", onPath ? "edge-on" : ""]
            .filter(Boolean)
            .join(" ")
        };
      }),
    [graph.edges, activeId]
  );

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

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
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={(_event, node) => setHoveredId(node.id)}
        onNodeMouseLeave={() => setHoveredId(undefined)}
      >
        <Background gap={24} color="rgba(242, 238, 230, 0.06)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function relatedNodeIds(graph: SnitchGraph, activeId: string | undefined): Set<string> | undefined {
  if (!activeId) {
    return undefined;
  }

  const related = new Set<string>([activeId]);
  let frontier = new Set<string>([activeId]);

  for (let depth = 0; depth < 2; depth += 1) {
    const next = new Set<string>();

    for (const edge of graph.edges) {
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
      const data: SystemNodeData = {
        label: node.label,
        kind: node.kind,
        dimmed: Boolean(neighborhood) && !neighborhood?.has(node.id),
        emphasized: activeId === node.id
      };

      if (node.file) {
        data.file = node.file;
      }
      if (typeof node.line === "number") {
        data.line = node.line;
      }
      if (typeof node.meta?.severity === "string") {
        data.severity = node.meta.severity;
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
        className: `node-${node.kind}`,
        draggable: false
      });
    });
  }

  return positioned;
}

// VS Code / Cursor understand vscode://file/<abs-path>:<line>, so a warning's anchor opens
// straight in the editor when the live server tells us the repo root.
function buildEditorHref(cwd: string | undefined, file: string | undefined, line: number | undefined): string | undefined {
  if (!cwd || !file) {
    return undefined;
  }

  const absolute = `${cwd.replace(/\/$/, "")}/${file}`;
  return `vscode://file/${absolute}${typeof line === "number" ? `:${line}` : ""}`;
}
