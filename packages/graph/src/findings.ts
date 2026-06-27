import type { GraphNode, NodeKind, SnitchFinding, SnitchGraph, SnitchWarning } from "./types";

type FindingAnchor = NonNullable<SnitchFinding["anchor"]>;

export function buildSnitchFindings(
  graph: SnitchGraph,
  warnings: SnitchWarning[]
): SnitchFinding[] {
  return warnings.map((warning) => {
    const relatedNodes = relatedNodesForWarning(graph, warning);
    const anchor = selectFindingAnchor(relatedNodes);
    const finding: SnitchFinding = {
      id: `finding:${warning.id.replace(/^warning:/, "")}`,
      warningId: warning.id,
      severity: warning.severity,
      title: warning.title,
      message: warning.message,
      evidence: warning.evidence,
      relatedNodeIds: relatedNodes.map((node) => node.id),
      repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
    };

    if (anchor) {
      finding.anchor = anchor;
    }

    return finding;
  });
}

function relatedNodesForWarning(graph: SnitchGraph, warning: SnitchWarning): GraphNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const relatedIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from === warning.id) {
      relatedIds.add(edge.to);
    }

    if (edge.to === warning.id) {
      relatedIds.add(edge.from);
    }
  }

  for (const evidence of warning.evidence) {
    for (const node of graph.nodes) {
      if (evidence.includes(node.id)) {
        relatedIds.add(node.id);
      }
    }
  }

  relatedIds.add(warning.id);

  return [...relatedIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node))
    .sort((left, right) => nodePriority(left.kind) - nodePriority(right.kind) || left.id.localeCompare(right.id));
}

function selectFindingAnchor(nodes: GraphNode[]): FindingAnchor | undefined {
  const node = nodes.find((candidate) => candidate.kind !== "warning" && candidate.file);

  if (!node?.file) {
    return undefined;
  }

  const anchor: FindingAnchor = {
    nodeId: node.id,
    label: node.label,
    file: node.file
  };

  if (typeof node.line === "number") {
    anchor.line = node.line;
  }

  return anchor;
}

function nodePriority(kind: NodeKind): number {
  return {
    tool: 0,
    endpoint: 1,
    service: 2,
    schema: 3,
    database: 4,
    external: 5,
    env: 6,
    contract: 7,
    test: 8,
    agent: 9,
    warning: 10
  }[kind];
}
