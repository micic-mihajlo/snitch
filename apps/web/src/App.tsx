import { useEffect, useMemo, useState } from "react";
import {
  buildSnitchArtifacts,
  createStaticNarration,
  diffGraph,
  type GraphEdge,
  type GraphNode,
  type SnitchWarning
} from "@snitch/graph";
import { ChangedFiles } from "./components/ChangedFiles";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Findings } from "./components/Findings";
import { GraphCanvas } from "./components/GraphCanvas";
import { InsightFooter } from "./components/InsightFooter";
import { NextAction } from "./components/NextAction";
import { ReviewExport } from "./components/ReviewExport";
import { scopeGraph, type GraphScope } from "./lib/graphScope";
import { type RankedWarningView, useLiveSnitch } from "./lib/useLiveSnitch";
import { useReplay } from "./lib/useReplay";

const fallbackTask =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

const LENSES = [
  { id: "diagram", label: "Change" },
  { id: "impacted", label: "Impact" },
  { id: "all", label: "Full" }
] as const satisfies ReadonlyArray<{ id: GraphScope; label: string }>;

export default function App() {
  const replay = useReplay();
  const live = useLiveSnitch();
  const [createdAt] = useState(() => new Date().toISOString());
  const [graphScope, setGraphScope] = useState<GraphScope>("diagram");
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);

  const isLive = live.status === "live";
  const currentSnapshot = live.snapshot ?? replay.currentSnapshot;
  const previousSnapshot = live.previousSnapshot ?? replay.previousSnapshot;
  const visibleSnapshots = live.snapshot ? [currentSnapshot] : replay.snapshots;
  const reviewSnapshot = live.snapshot ?? replay.reviewSnapshot;

  const rankedWarnings = useMemo(
    () => applyRankings(currentSnapshot.warnings, live.rankedWarnings),
    [currentSnapshot.warnings, live.rankedWarnings]
  );
  const rankingByWarningId = useMemo(() => indexRankings(live.rankedWarnings), [live.rankedWarnings]);

  const [selectedWarningId, setSelectedWarningId] = useState<string | undefined>(rankedWarnings[0]?.id);
  const [userPickedWarning, setUserPickedWarning] = useState(false);
  const selectedWarning =
    rankedWarnings.find((warning) => warning.id === selectedWarningId) ?? rankedWarnings[0];
  const selectedRanking = selectedWarning ? rankingByWarningId[selectedWarning.id] : undefined;

  const nodeById = useMemo(
    () => new Map(currentSnapshot.graph.nodes.map((node) => [node.id, node])),
    [currentSnapshot.graph.nodes]
  );
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;

  const diff = useMemo(
    () => diffGraph(previousSnapshot.graph, currentSnapshot.graph),
    [currentSnapshot, previousSnapshot]
  );
  const changedFilePaths = useMemo(
    () =>
      live.changed?.changedFiles.flatMap((file) =>
        [file.targetPath, file.path].filter((path): path is string => Boolean(path))
      ) ?? [],
    [live.changed]
  );

  const artifacts = useMemo(
    () =>
      live.artifacts ??
      buildSnitchArtifacts({
        replay: visibleSnapshots,
        reviewSnapshot,
        createdAt,
        runId: "snitch-ui-preview",
        task: fallbackTask
      }),
    [createdAt, live.artifacts, reviewSnapshot, visibleSnapshots]
  );
  const narration = useMemo(
    () => createStaticNarration(diff, rankedWarnings),
    [rankedWarnings, diff]
  );
  const integration = live.integrationPanel ?? {
    narration,
    ruleCount: 0,
    cerebrasStatus: "static fallback",
    backboardStatus: "not connected",
    memoryStatus: "not connected"
  };

  const scopedGraph = useMemo(() => {
    const scopeOptions: Parameters<typeof scopeGraph>[4] = { changedFiles: changedFilePaths };
    if (live.diagram?.graph) {
      scopeOptions.diagram = live.diagram.graph;
    }
    return scopeGraph(currentSnapshot.graph, diff, graphScope, selectedWarning?.id, scopeOptions);
  }, [changedFilePaths, currentSnapshot.graph, diff, graphScope, live.diagram?.graph, selectedWarning?.id]);

  const scopedNodeIds = useMemo(() => new Set(scopedGraph.nodes.map((node) => node.id)), [scopedGraph.nodes]);
  const selectedNodeInScope = selectedNode && scopedNodeIds.has(selectedNode.id) ? selectedNode : undefined;
  const selectedNodeEdges = useMemo(
    () => edgesForNode(scopedGraph.edges, selectedNodeInScope?.id),
    [scopedGraph.edges, selectedNodeInScope?.id]
  );
  const focusedNodeId = selectedNode && scopedNodeIds.has(selectedNode.id)
    ? selectedNode.id
    : selectedWarning && scopedNodeIds.has(selectedWarning.id)
      ? selectedWarning.id
      : undefined;

  const changed = live.changed;
  const changedClean = Boolean(changed && changed.git.available && changed.counts.changedFindings === 0);

  const showDiagramSummary = graphScope === "diagram" && Boolean(live.diagram);
  const graphMeter = showDiagramSummary && live.diagram
    ? `${live.diagram.status}${live.diagram.model ? ` · ${live.diagram.model}` : ""} · ${scopedGraph.nodes.length} nodes`
    : `${scopedGraph.nodes.length}/${currentSnapshot.graph.nodes.length} nodes`;

  // Until the reviewer clicks a finding, keep the selection pinned to the top-ranked one so
  // the Next action card, the Findings list, and the map focus all agree on "what matters most".
  useEffect(() => {
    const stillValid = rankedWarnings.some((warning) => warning.id === selectedWarningId);
    if (!stillValid) {
      setSelectedWarningId(rankedWarnings[0]?.id);
      setSelectedNodeId(rankedWarnings[0]?.id);
      return;
    }
    if (!userPickedWarning && rankedWarnings[0] && rankedWarnings[0].id !== selectedWarningId) {
      setSelectedWarningId(rankedWarnings[0].id);
      setSelectedNodeId(rankedWarnings[0].id);
    }
  }, [rankedWarnings, selectedWarningId, userPickedWarning]);

  useEffect(() => {
    if (!selectedNodeId || !nodeById.has(selectedNodeId)) {
      setSelectedNodeId(selectedWarning?.id);
    }
  }, [nodeById, selectedNodeId, selectedWarning?.id]);

  function handleSelectWarning(warning: SnitchWarning) {
    setUserPickedWarning(true);
    setSelectedWarningId(warning.id);
    setSelectedNodeId(warning.id);
  }

  const task = live.task ?? fallbackTask;
  const sourceLabel = isLive ? live.graphSourceLabel.replace(/^live\s+/, "") : "";
  const connectionDetail = isLive
    ? `Live · ${sourceLabel}${typeof live.eventCount === "number" ? ` · ${live.eventCount} events` : ""}`
    : "Offline preview";

  const anchor = nextActionAnchor(selectedNode ?? (selectedWarning ? nodeById.get(selectedWarning.id) : undefined), live.cwd);

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <h1 className="wordmark">Snitch</h1>
          <ConnectionStatus live={isLive} detail={connectionDetail} />
        </div>
        <p className="review-subject">
          <b>Reviewing</b> · {task}
        </p>
      </header>

      <section className="card summary-stats" aria-label="Review summary">
        <Stat label="Changed" value={`${changed?.counts.changedFiles ?? changedFilePaths.length}`} sub="files in diff" />
        <Stat
          label="Findings"
          value={`${changed?.counts.changedFindings ?? rankedWarnings.length}`}
          sub={`${rankedWarnings.length} repo-wide`}
          tone={changedClean ? "clear" : (changed?.counts.changedFindings ?? rankedWarnings.length) > 0 ? "hot" : undefined}
        />
        <Stat
          label="Base"
          value={changed?.git.baseRef ?? changed?.target ?? (sourceLabel || "—")}
          sub={`${currentSnapshot.graph.nodes.length} nodes mapped`}
          mono
        />
      </section>

      {changedClean ? (
        <NextAction
          clear
          title="No findings on the changed files"
          prompt="This diff has no active Snitch findings against the base. Repo-wide findings, if any, are listed below."
        />
      ) : selectedWarning ? (
        <NextAction
          clear={false}
          title={selectedWarning.title}
          severity={selectedWarning.severity}
          reason={selectedRanking?.reason}
          prompt={warningActionText(selectedWarning)}
          copyValue={selectedWarning.repairPrompt?.trim() || undefined}
          anchor={anchor}
        />
      ) : (
        <NextAction clear title="No active findings" prompt="Snitch found nothing to flag in the current graph." />
      )}

      <ChangedFiles changed={changed} />

      <section className="card graph-card" aria-label="System map">
        <div className="graph-head">
          <h2 className="section-title">System map</h2>
          <div className="lens-toggle" role="group" aria-label="Map lens">
            {LENSES.map((lens) => (
              <button
                key={lens.id}
                type="button"
                className={lens.id === graphScope ? "lens is-active" : "lens"}
                aria-pressed={lens.id === graphScope}
                onClick={() => setGraphScope(lens.id)}
              >
                {lens.label}
              </button>
            ))}
          </div>
          <span className="graph-meter">{graphMeter}</span>
        </div>
        {showDiagramSummary && live.diagram ? (
          <p className="graph-summary">{live.diagram.summary}</p>
        ) : null}
        <GraphCanvas
          graph={scopedGraph}
          selectedNodeId={focusedNodeId}
          onSelectNode={(node) => setSelectedNodeId(node.id)}
          cwd={live.cwd}
        />
        <SelectionStrip node={selectedNodeInScope} edges={selectedNodeEdges} cwd={live.cwd} />
      </section>

      <Findings
        warnings={rankedWarnings}
        selectedWarning={selectedWarning}
        rankingByWarningId={rankingByWarningId}
        onSelect={handleSelectWarning}
      />

      <InsightFooter
        lines={compactNarration(live.diagram?.summary ?? integration.narration)}
        cerebrasStatus={integration.cerebrasStatus}
        backboardStatus={integration.backboardStatus}
      />

      <ReviewExport prComment={artifacts["pr-comment.md"]} />
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  mono
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "hot" | "clear" | undefined;
  mono?: boolean | undefined;
}) {
  return (
    <div className={["stat", tone ? `is-${tone}` : ""].filter(Boolean).join(" ")}>
      <span className="stat-label">{label}</span>
      <strong className={mono ? "stat-value mono" : "stat-value"} title={value}>
        {value}
      </strong>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}

function SelectionStrip({
  node,
  edges,
  cwd
}: {
  node: GraphNode | undefined;
  edges: GraphEdge[];
  cwd: string | undefined;
}) {
  if (!node) {
    return (
      <div className="selection-strip" aria-label="Selected graph node">
        <span className="selection-kind">node</span>
        <span className="selection-title muted">Select a node to inspect it.</span>
      </div>
    );
  }

  const href = editorHref(cwd, node.file, node.line);
  const anchorLabel = node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : undefined;

  return (
    <div className="selection-strip" aria-label="Selected graph node">
      <span className="selection-kind">{kindLabel(node.kind)}</span>
      <span className="selection-title">{node.label}</span>
      {anchorLabel ? (
        href ? (
          <a className="selection-anchor" href={href}>
            {anchorLabel}
          </a>
        ) : (
          <span className="selection-anchor">{anchorLabel}</span>
        )
      ) : (
        <span className="selection-links">{edges.length} links</span>
      )}
    </div>
  );
}

function nextActionAnchor(
  node: GraphNode | undefined,
  cwd: string | undefined
): { href?: string; label: string } | undefined {
  if (!node?.file) {
    return undefined;
  }

  const label = `${node.file}${node.line ? `:${node.line}` : ""}`;
  const href = editorHref(cwd, node.file, node.line);
  return href ? { href, label } : { label };
}

function compactNarration(narration: string): string[] {
  const lines = narration
    .split(/\n+/)
    .map((line) => line.replace(/^[*\-\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);

  return (lines.length > 0 ? lines : ["No integration narration is available yet."]).slice(0, 4);
}

function edgesForNode(edges: GraphEdge[], nodeId: string | undefined): GraphEdge[] {
  if (!nodeId) {
    return [];
  }

  return edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
}

function kindLabel(kind: GraphNode["kind"]): string {
  return kind === "endpoint" ? "route" : kind;
}

function warningActionText(warning: SnitchWarning): string {
  return warning.repairPrompt?.trim() || warning.message || "No repair instruction available.";
}

function editorHref(cwd: string | undefined, file: string | undefined, line: number | undefined): string | undefined {
  if (!cwd || !file) {
    return undefined;
  }

  return `vscode://file/${cwd.replace(/\/$/, "")}/${file}${typeof line === "number" ? `:${line}` : ""}`;
}

function applyRankings(
  warnings: SnitchWarning[],
  rankings: RankedWarningView[] | undefined
): SnitchWarning[] {
  if (!rankings || rankings.length === 0) {
    return warnings;
  }

  const rankingById = indexRankings(rankings);

  return warnings
    .map((warning) => {
      const ranking = rankingById[warning.id];

      if (!ranking || !ranking.repairPrompt.trim()) {
        return warning;
      }

      return {
        ...warning,
        repairPrompt: ranking.repairPrompt
      };
    })
    .sort((left, right) => {
      const leftRank = rankingById[left.id]?.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankingById[right.id]?.rank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
}

function indexRankings(
  rankings: RankedWarningView[] | undefined
): Record<string, RankedWarningView> {
  return Object.fromEntries((rankings ?? []).map((ranking) => [ranking.warningId, ranking]));
}
