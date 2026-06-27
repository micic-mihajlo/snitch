import {
  scopeGraph as scopeBaseGraph,
  type GraphDiff,
  type GraphScope as BaseGraphScope,
  type SnitchGraph
} from "@snitch/graph";

export type GraphScope = BaseGraphScope | "diagram";

export function scopeGraph(
  graph: SnitchGraph,
  diff: GraphDiff,
  scope: GraphScope,
  selectedWarningId?: string,
  options: {
    changedFiles?: string[];
    diagram?: SnitchGraph;
  } = {}
): SnitchGraph {
  if (scope === "diagram") {
    return options.diagram ?? scopeBaseGraph(graph, diff, "changed", selectedWarningId, options.changedFiles);
  }

  return scopeBaseGraph(graph, diff, scope, selectedWarningId, options.changedFiles);
}
