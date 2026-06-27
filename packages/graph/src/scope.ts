import type { GraphDiff, SnitchGraph } from "./types";

export type GraphScope = "all" | "changed" | "impacted";

export function scopeGraph(
  graph: SnitchGraph,
  diff: GraphDiff,
  scope: GraphScope,
  selectedWarningId?: string
): SnitchGraph {
  if (scope === "all") {
    return graph;
  }

  const nodeIds = scope === "changed"
    ? changedNodeIds(diff)
    : impactedNodeIds(graph, selectedWarningId);

  if (nodeIds.size === 0) {
    return graph;
  }

  const edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const edgeEndpoints = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id) || edgeEndpoints.has(node.id));

  return {
    ...graph,
    id: `${graph.id}:${scope}`,
    title: `${graph.title} (${scope})`,
    nodes,
    edges
  };
}

function changedNodeIds(diff: GraphDiff): Set<string> {
  const ids = new Set<string>();

  for (const node of diff.addedNodes) {
    ids.add(node.id);
  }

  for (const change of diff.changedNodes) {
    ids.add(change.next.id);
  }

  for (const edge of [...diff.addedEdges, ...diff.changedEdges.map((change) => change.next)]) {
    ids.add(edge.from);
    ids.add(edge.to);
  }

  return ids;
}

function impactedNodeIds(graph: SnitchGraph, selectedWarningId?: string): Set<string> {
  const kindById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const warningIds = new Set(
    selectedWarningId
      ? [selectedWarningId]
      : graph.nodes.filter((node) => node.kind === "warning").map((node) => node.id)
  );
  const ids = new Set(warningIds);

  for (const edge of graph.edges) {
    if (warningIds.has(edge.from) || warningIds.has(edge.to)) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
  }

  const firstHop = new Set(ids);

  for (const edge of graph.edges) {
    if (firstHop.has(edge.from) || firstHop.has(edge.to)) {
      addNonCompetingWarning(ids, kindById, warningIds, edge.from);
      addNonCompetingWarning(ids, kindById, warningIds, edge.to);
    }
  }

  return ids;
}

function addNonCompetingWarning(
  ids: Set<string>,
  kindById: Map<string, string>,
  selectedWarningIds: Set<string>,
  id: string
): void {
  if (kindById.get(id) === "warning" && !selectedWarningIds.has(id)) {
    return;
  }

  ids.add(id);
}
