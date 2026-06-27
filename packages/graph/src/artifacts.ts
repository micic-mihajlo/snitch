import { diffGraph } from "./diff";
import { graphToMermaid } from "./mermaid";
import type { ReplaySnapshot, SnitchArtifactInput, SnitchArtifacts, SnitchWarning } from "./types";

export function buildSnitchArtifacts(input: SnitchArtifactInput): SnitchArtifacts {
  const mermaid = graphToMermaid(input.reviewSnapshot.graph);

  return {
    "session.json": JSON.stringify(
      {
        runId: input.runId,
        task: input.task,
        createdAt: input.createdAt,
        source: input.source ?? "snitch-demo-replay",
        reviewSnapshotId: input.reviewSnapshot.id
      },
      null,
      2
    ),
    "graph.json": JSON.stringify(input.reviewSnapshot.graph, null, 2),
    "timeline.jsonl": buildTimelineJsonl(input.replay),
    "mermaid.mmd": mermaid,
    "handoff.md": buildHandoff(input.reviewSnapshot, input.task),
    "pr-comment.md": buildPrComment(input.reviewSnapshot, mermaid)
  };
}

function buildTimelineJsonl(replay: ReplaySnapshot[]): string {
  return replay
    .map((snapshot, index) => {
      const previous = replay[index - 1];
      const diff = previous ? diffGraph(previous.graph, snapshot.graph) : undefined;

      return JSON.stringify({
        snapshotId: snapshot.id,
        title: snapshot.title,
        description: snapshot.description,
        warningCount: snapshot.warnings.length,
        diffSummary: diff?.summary ?? {
          addedNodes: snapshot.graph.nodes.length,
          removedNodes: 0,
          changedNodes: 0,
          addedEdges: snapshot.graph.edges.length,
          removedEdges: 0,
          changedEdges: 0
        }
      });
    })
    .join("\n");
}

function buildHandoff(snapshot: ReplaySnapshot, task: string): string {
  return [
    "# Snitch Handoff",
    "",
    `Task: ${task}`,
    "",
    `Review snapshot: ${snapshot.title}`,
    "",
    "## System Impact",
    "",
    `- Nodes: ${snapshot.graph.nodes.length}`,
    `- Edges: ${snapshot.graph.edges.length}`,
    `- Warnings: ${snapshot.warnings.length}`,
    "",
    "## Missing companion warnings",
    "",
    ...formatWarningBullets(snapshot.warnings)
  ].join("\n");
}

function buildPrComment(snapshot: ReplaySnapshot, mermaid: string): string {
  return [
    "## Snitch Review",
    "",
    "Snitch detected an external issue-creation capability and checked for companion safety work.",
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
    "### Warnings",
    "",
    ...formatWarningBullets(snapshot.warnings)
  ].join("\n");
}

function formatWarningBullets(warnings: SnitchWarning[]): string[] {
  if (warnings.length === 0) {
    return ["- No active Snitch warnings."];
  }

  return warnings.flatMap((warning) => [
    `- **${warning.title}** (${warning.severity})`,
    `  - ${warning.message}`,
    `  - Evidence: ${warning.evidence.join("; ")}`,
    warning.repairPrompt ? `  - Repair prompt: ${warning.repairPrompt}` : ""
  ]);
}
