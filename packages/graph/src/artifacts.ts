import { diffGraph } from "./diff";
import { buildSnitchFindings } from "./findings";
import { graphToMermaid } from "./mermaid";
import type {
  GraphNode,
  NodeKind,
  ReplaySnapshot,
  SnitchArtifactInput,
  SnitchArtifacts,
  SnitchWarning
} from "./types";

export function buildSnitchArtifacts(input: SnitchArtifactInput): SnitchArtifacts {
  const mermaid = graphToMermaid(input.reviewSnapshot.graph);
  const findings = buildSnitchFindings(input.reviewSnapshot.graph, input.reviewSnapshot.warnings);

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
    "warnings.json": JSON.stringify(input.reviewSnapshot.warnings, null, 2),
    "findings.json": JSON.stringify(findings, null, 2),
    "next-action.md": buildNextAction(input.reviewSnapshot, input.task, findings),
    "timeline.jsonl": buildTimelineJsonl(input.replay),
    "mermaid.mmd": mermaid,
    "handoff.md": buildHandoff(input.reviewSnapshot, input.task, findings),
    "pr-comment.md": buildPrComment(input.reviewSnapshot, mermaid, findings)
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

function buildHandoff(
  snapshot: ReplaySnapshot,
  task: string,
  findings: ReturnType<typeof buildSnitchFindings>
): string {
  return [
    "# Snitch Handoff",
    "",
    `Task: ${task}`,
    "",
    `Review snapshot: ${snapshot.title}`,
    "",
    "## System Impact",
    "",
    ...formatImpactBullets(snapshot),
    "",
    "## Active warnings",
    "",
    ...formatWarningBullets(snapshot.warnings),
    "",
    "## Review findings",
    "",
    ...formatFindingBullets(findings)
  ].join("\n");
}

function buildPrComment(
  snapshot: ReplaySnapshot,
  mermaid: string,
  findings: ReturnType<typeof buildSnitchFindings>
): string {
  return [
    "## Snitch Review",
    "",
    "Snitch generated a code-derived system map for this change and checked active warning contracts.",
    "",
    "### System Impact",
    "",
    ...formatImpactBullets(snapshot),
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
    "### Warnings",
    "",
    ...formatWarningBullets(snapshot.warnings),
    "",
    "### Review Findings",
    "",
    ...formatFindingBullets(findings)
  ].join("\n");
}

function buildNextAction(
  snapshot: ReplaySnapshot,
  task: string,
  findings: ReturnType<typeof buildSnitchFindings>
): string {
  const topFinding = findings[0];

  if (!topFinding) {
    return [
      "# Snitch Next Action",
      "",
      `Task: ${task}`,
      "",
      "Status: clear",
      "",
      "No active Snitch findings. Continue with normal implementation and run `pnpm snitch check` before handoff."
    ].join("\n");
  }

  const location = topFinding.anchor
    ? `${topFinding.anchor.file}${topFinding.anchor.line ? `:${topFinding.anchor.line}` : ""}`
    : "unanchored";

  return [
    "# Snitch Next Action",
    "",
    `Task: ${task}`,
    "",
    "Status: action_required",
    `Active warnings: ${snapshot.warnings.length}`,
    "",
    "Top finding:",
    `- [${topFinding.severity}] ${topFinding.title}`,
    `- Warning ID: ${topFinding.warningId}`,
    `- Anchor: ${location}`,
    `- Repair: ${topFinding.repairCommand}`,
    "",
    "Evidence:",
    ...topFinding.evidence.map((item) => `- ${item}`),
    "",
    "Instruction for the coding agent:",
    "Address this finding before continuing broad implementation. Add the missing companion work, then rerun Snitch to verify the warning is gone.",
    "",
    "Verification:",
    "- Run the repair command above for the full focused prompt.",
    "- Run `pnpm snitch check --fail-on medium --json` after the fix.",
    "- Confirm `.snitch/warnings.json` no longer contains the warning ID."
  ].join("\n");
}

function formatImpactBullets(snapshot: ReplaySnapshot): string[] {
  const graph = snapshot.graph;
  const lines = [
    `- Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    `- Active warnings: ${formatWarningSummary(snapshot.warnings)}`
  ];

  for (const group of impactGroups) {
    const matchingNodes = graph.nodes
      .filter((node) => group.kinds.includes(node.kind))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (matchingNodes.length === 0) {
      continue;
    }

    lines.push(`- ${group.title}: ${formatNodeList(matchingNodes)}`);
  }

  return lines;
}

function formatWarningSummary(warnings: SnitchWarning[]): string {
  if (warnings.length === 0) {
    return "none";
  }

  const counts = new Map<SnitchWarning["severity"], number>();

  for (const warning of warnings) {
    counts.set(warning.severity, (counts.get(warning.severity) ?? 0) + 1);
  }

  const severityText = ["high", "medium", "low", "info"]
    .flatMap((severity) => {
      const count = counts.get(severity as SnitchWarning["severity"]) ?? 0;
      return count > 0 ? [`${count} ${severity}`] : [];
    })
    .join(", ");

  return `${warnings.length}${severityText ? ` (${severityText})` : ""}`;
}

function formatNodeList(nodes: GraphNode[]): string {
  const shown = nodes.slice(0, 4).map(formatNode);
  const hiddenCount = nodes.length - shown.length;

  return hiddenCount > 0 ? `${shown.join(", ")}, +${hiddenCount} more` : shown.join(", ");
}

function formatNode(node: GraphNode): string {
  const location = node.file ? ` (${node.file}${node.line ? `:${node.line}` : ""})` : "";
  return `${node.label}${location}`;
}

const impactGroups: Array<{ title: string; kinds: NodeKind[] }> = [
  { title: "Agent surfaces", kinds: ["agent"] },
  { title: "Endpoints", kinds: ["endpoint"] },
  { title: "Tools", kinds: ["tool"] },
  { title: "Schemas", kinds: ["schema"] },
  { title: "External systems", kinds: ["external"] },
  { title: "Environment", kinds: ["env"] },
  { title: "Data stores", kinds: ["database"] },
  { title: "Services", kinds: ["service"] },
  { title: "Contracts", kinds: ["contract"] },
  { title: "Tests", kinds: ["test"] }
];

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

function formatFindingBullets(findings: ReturnType<typeof buildSnitchFindings>): string[] {
  if (findings.length === 0) {
    return ["- No active Snitch findings."];
  }

  return findings.map((finding) => {
    const location = finding.anchor
      ? `${finding.anchor.file}${finding.anchor.line ? `:${finding.anchor.line}` : ""}`
      : "unanchored";

    return `- **${finding.title}** (${finding.severity}) at ${location} - ${finding.repairCommand}`;
  });
}
