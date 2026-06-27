import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { GraphNode, SnitchGraph } from "@snitch/graph";

type Props = {
  graph: SnitchGraph;
};

const columnByKind: Partial<Record<GraphNode["kind"], number>> = {
  agent: 0,
  service: 1,
  tool: 2,
  schema: 3,
  env: 3,
  external: 4,
  contract: 4,
  test: 4,
  warning: 5
};

export function GraphCanvas({ graph }: Props) {
  const nodes = toFlowNodes(graph.nodes);
  const edges = graph.edges.map<Edge>((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.kind,
    animated: edge.kind === "missing" || edge.kind === "calls",
    className: `edge-${edge.kind}`
  }));

  return (
    <div className="graph-frame" data-testid="graph-frame">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.35}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="rgba(242, 238, 230, 0.08)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function toFlowNodes(nodes: GraphNode[]): Node[] {
  const rowByColumn = new Map<number, number>();

  return nodes.map((node) => {
    const column = columnByKind[node.kind] ?? 2;
    const row = rowByColumn.get(column) ?? 0;
    rowByColumn.set(column, row + 1);

    return {
      id: node.id,
      data: {
        label: node.label
      },
      position: {
        x: column * 235,
        y: row * 118
      },
      className: `graph-node node-${node.kind}`
    };
  });
}
