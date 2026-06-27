import type {
  ChangedItem,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphUpdate,
  GraphUpdateResult,
  SnitchGraph
} from "./types";

type HashableItem = {
  id: string;
  hash: string;
};

export function diffGraph(previous: SnitchGraph, next: SnitchGraph): GraphDiff {
  const nodeDiff = diffItems(previous.nodes, next.nodes);
  const edgeDiff = diffItems(previous.edges, next.edges);

  return {
    addedNodes: nodeDiff.added,
    removedNodes: nodeDiff.removed,
    changedNodes: nodeDiff.changed,
    unchangedNodes: nodeDiff.unchanged,
    addedEdges: edgeDiff.added,
    removedEdges: edgeDiff.removed,
    changedEdges: edgeDiff.changed,
    unchangedEdges: edgeDiff.unchanged,
    summary: {
      addedNodes: nodeDiff.added.length,
      removedNodes: nodeDiff.removed.length,
      changedNodes: nodeDiff.changed.length,
      addedEdges: edgeDiff.added.length,
      removedEdges: edgeDiff.removed.length,
      changedEdges: edgeDiff.changed.length
    }
  };
}

export function keepLastGoodGraph(
  previous: SnitchGraph,
  update: GraphUpdate
): GraphUpdateResult {
  if (update.ok) {
    return {
      accepted: true,
      graph: update.graph,
      warnings: []
    };
  }

  return {
    accepted: false,
    graph: previous,
    warnings: [
      {
        id: "warning:last_good_graph_retained",
        kind: "warning",
        severity: "info",
        title: "Last valid graph retained",
        message: `${update.source} failed, so Snitch kept the previous graph visible.`,
        evidence: [update.error]
      }
    ]
  };
}

export function hashEvidence(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function diffItems<T extends HashableItem>(previous: T[], next: T[]) {
  const previousById = indexById(previous);
  const nextById = indexById(next);
  const added: T[] = [];
  const removed: T[] = [];
  const changed: ChangedItem<T>[] = [];
  const unchanged: T[] = [];

  for (const nextItem of next) {
    const previousItem = previousById.get(nextItem.id);

    if (!previousItem) {
      added.push(nextItem);
      continue;
    }

    if (previousItem.hash === nextItem.hash) {
      unchanged.push(nextItem);
      continue;
    }

    changed.push({
      id: nextItem.id,
      previous: previousItem,
      next: nextItem
    });
  }

  for (const previousItem of previous) {
    if (!nextById.has(previousItem.id)) {
      removed.push(previousItem);
    }
  }

  return { added, removed, changed, unchanged };
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export type { GraphDiff, GraphEdge, GraphNode, SnitchGraph };
