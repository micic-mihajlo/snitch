import type { SnitchGraph } from "./types";

export function graphToMermaid(graph: SnitchGraph): string {
  const nodeLines = [...graph.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => `  ${toMermaidId(node.id)}["${escapeLabel(node.label)}"]`);
  const edgeLines = [...graph.edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (edge) =>
        `  ${toMermaidId(edge.from)} -->|${escapeLabel(edge.kind)}| ${toMermaidId(edge.to)}`
    );

  return ["flowchart LR", ...nodeLines, ...edgeLines].join("\n");
}

function toMermaidId(id: string): string {
  const normalized = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(normalized) ? normalized : `n_${normalized}`;
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, '\\"').replace(/\|/g, "&#124;");
}
