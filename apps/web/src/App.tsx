import { RotateCcw, StepForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  buildSnitchArtifacts,
  createStaticNarration,
  diffGraph,
  type GraphEdge,
  type GraphNode,
  type SnitchWarning
} from "@snitch/graph";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { IntegrationPanel } from "./components/IntegrationPanel";
import { Timeline } from "./components/Timeline";
import { WarningRail } from "./components/WarningRail";
import { scopeGraph, type GraphScope } from "./lib/graphScope";
import { type ChangedSurfaceView, type RankedWarningView, useLiveSnitch } from "./lib/useLiveSnitch";
import { useReplay } from "./lib/useReplay";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export default function App() {
  const replay = useReplay();
  const live = useLiveSnitch();
  const [createdAt] = useState(() => new Date().toISOString());
  const [graphScope, setGraphScope] = useState<GraphScope>("diagram");
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const currentSnapshot = live.snapshot ?? replay.currentSnapshot;
  const previousSnapshot = live.previousSnapshot ?? replay.previousSnapshot;
  const visibleSnapshots = live.snapshot ? [currentSnapshot] : replay.snapshots;
  const reviewSnapshot = live.snapshot ?? replay.reviewSnapshot;
  const rankedWarnings = useMemo(
    () => applyRankings(currentSnapshot.warnings, live.rankedWarnings),
    [currentSnapshot.warnings, live.rankedWarnings]
  );
  const rankingByWarningId = useMemo(
    () => indexRankings(live.rankedWarnings),
    [live.rankedWarnings]
  );
  const [selectedWarningId, setSelectedWarningId] = useState<string | undefined>(
    rankedWarnings[0]?.id
  );
  const selectedWarning =
    rankedWarnings.find((warning) => warning.id === selectedWarningId) ??
    rankedWarnings[0];
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
        task
      }),
    [createdAt, live.artifacts, reviewSnapshot, visibleSnapshots]
  );
  const narration = useMemo(
    () => createStaticNarration(diff, rankedWarnings),
    [rankedWarnings, diff]
  );
  const integrationPanel = live.integrationPanel ?? {
    narration,
    ruleCount: 0,
    cerebrasStatus: "static fallback",
    backboardStatus: "not connected",
    memoryStatus: "not connected"
  };
  const scopedGraph = useMemo(
    () => {
      const scopeOptions: Parameters<typeof scopeGraph>[4] = {
        changedFiles: changedFilePaths
      };

      if (live.diagram?.graph) {
        scopeOptions.diagram = live.diagram.graph;
      }

      return scopeGraph(currentSnapshot.graph, diff, graphScope, selectedWarning?.id, scopeOptions);
    },
    [changedFilePaths, currentSnapshot.graph, diff, graphScope, live.diagram?.graph, selectedWarning?.id]
  );
  const scopedNodeIds = useMemo(
    () => new Set(scopedGraph.nodes.map((node) => node.id)),
    [scopedGraph.nodes]
  );
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
  const graphFallbackWarning =
    graphScope === "diagram" && live.changed?.counts.changedFindings === 0 ? undefined : selectedWarning;
  const mapTitle = graphScope === "diagram" ? "Cerebras Diagram" : "Live System Map";
  const mapMeter = graphScope === "diagram" && live.diagram
    ? `${live.diagram.status}${live.diagram.model ? ` · ${live.diagram.model}` : ""} · ${scopedGraph.nodes.length} nodes`
    : `${scopedGraph.nodes.length}/${currentSnapshot.graph.nodes.length} nodes · +${diff.summary.addedNodes} / +${diff.summary.addedEdges}`;

  useEffect(() => {
    if (!rankedWarnings.some((warning) => warning.id === selectedWarningId)) {
      setSelectedWarningId(rankedWarnings[0]?.id);
    }
  }, [rankedWarnings, selectedWarningId]);

  useEffect(() => {
    if (!selectedNodeId || !nodeById.has(selectedNodeId)) {
      setSelectedNodeId(selectedWarning?.id);
    }
  }, [nodeById, selectedNodeId, selectedWarning?.id]);

  function handleNext() {
    if (live.status === "live") {
      return;
    }

    const nextSnapshot = replay.advance();
    setSelectedWarningId(nextSnapshot.warnings[0]?.id);
    setSelectedNodeId(nextSnapshot.warnings[0]?.id);
  }

  function handleReset() {
    if (live.status === "live") {
      return;
    }

    const resetSnapshot = replay.reset();
    setSelectedWarningId(resetSnapshot.warnings[0]?.id);
    setSelectedNodeId(resetSnapshot.warnings[0]?.id);
  }

  function handleSelectWarning(warning: SnitchWarning) {
    setSelectedWarningId(warning.id);
    setSelectedNodeId(warning.id);
  }

  return (
    <main className="snitch-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Live truth layer</p>
          <h1>Snitch</h1>
        </div>
        <div className="toolbar" aria-label="Replay controls">
          <output className={`live-status live-status-${live.status}`}>
            {live.graphSourceLabel}
            {typeof live.eventCount === "number" ? ` / ${live.eventCount} events` : ""}
          </output>
          <button
            type="button"
            className="tool-button"
            onClick={handleNext}
            title="Advance replay"
            disabled={live.status === "live"}
          >
            <StepForward aria-hidden="true" size={18} />
            Replay next
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={handleReset}
            title="Reset replay"
            disabled={live.status === "live"}
          >
            <RotateCcw aria-hidden="true" size={18} />
            <span className="visually-hidden">Reset replay</span>
          </button>
        </div>
      </header>

      <DailyBrief
        task={live.task ?? task}
        graphSourceLabel={live.graphSourceLabel}
        graphNodeCount={currentSnapshot.graph.nodes.length}
        graphEdgeCount={currentSnapshot.graph.edges.length}
        warningCount={rankedWarnings.length}
        highWarningCount={rankedWarnings.filter((warning) => warning.severity === "high").length}
        changed={live.changed}
        selectedWarning={selectedWarning}
        diagramSummary={live.diagram?.summary}
        narration={integrationPanel.narration}
        cerebrasStatus={integrationPanel.cerebrasStatus}
        backboardStatus={integrationPanel.backboardStatus}
      />

      <section className="workspace-grid" aria-label="Snitch workspace">
        <section className="map-panel" aria-label="Live System Map">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Current graph</p>
              <h2>{mapTitle}</h2>
            </div>
            <div className="map-tools">
              <div className="segmented-control" aria-label="Graph scope">
                {(["diagram", "changed", "impacted", "all"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    className={scope === graphScope ? "segment selected" : "segment"}
                    aria-pressed={scope === graphScope}
                    onClick={() => setGraphScope(scope)}
                  >
                    {scope === "impacted" ? "Impact" : capitalize(scope)}
                  </button>
                ))}
              </div>
              <output className="diff-meter">
                {mapMeter}
              </output>
            </div>
          </div>
          {graphScope === "diagram" && live.diagram ? (
            <p className="diagram-summary">{live.diagram.summary}</p>
          ) : null}
          <GraphCanvas
            graph={scopedGraph}
            selectedNodeId={focusedNodeId}
            onSelectNode={(node) => setSelectedNodeId(node.id)}
            cwd={live.cwd}
          />
          <GraphSelectionStrip
            node={selectedNodeInScope}
            edges={selectedNodeEdges}
            fallbackWarning={graphFallbackWarning}
            cwd={live.cwd}
          />
        </section>

        <WarningRail
          warnings={rankedWarnings}
          selectedWarning={selectedWarning}
          rankingByWarningId={rankingByWarningId}
          onSelect={handleSelectWarning}
        />
      </section>

      <section className="lower-grid" aria-label="Snitch evidence">
        <Timeline
          snapshots={visibleSnapshots}
          currentSnapshotId={currentSnapshot.id}
        />
        <IntegrationPanel
          narration={integrationPanel.narration}
          ruleCount={integrationPanel.ruleCount}
          cerebrasStatus={integrationPanel.cerebrasStatus}
          backboardStatus={integrationPanel.backboardStatus}
          memoryStatus={integrationPanel.memoryStatus}
        />
        <ArtifactPanel artifacts={artifacts} />
      </section>
    </main>
  );
}

function DailyBrief({
  task,
  graphSourceLabel,
  graphNodeCount,
  graphEdgeCount,
  warningCount,
  highWarningCount,
  changed,
  selectedWarning,
  diagramSummary,
  narration,
  cerebrasStatus,
  backboardStatus
}: {
  task: string;
  graphSourceLabel: string;
  graphNodeCount: number;
  graphEdgeCount: number;
  warningCount: number;
  highWarningCount: number;
  changed: ChangedSurfaceView | undefined;
  selectedWarning: SnitchWarning | undefined;
  diagramSummary: string | undefined;
  narration: string;
  cerebrasStatus: string;
  backboardStatus: string;
}) {
  const changedLabel = changed
    ? changed.git.available
      ? `${changed.counts.changedFiles} changed / ${changed.counts.changedFindings} flagged`
      : "Git unavailable"
    : "No change data";
  const targetLabel = changed?.target ?? graphSourceLabel;
  const changedDetail = changed
    ? changed.git.baseRef
      ? `vs ${changed.git.baseRef}`
      : changed.git.diffMode === "worktree"
        ? "worktree status"
        : targetLabel
    : targetLabel;
  const hasChangedFindings = Boolean(changed && changed.counts.changedFindings > 0);
  const actionTitle = changed && changed.git.available && changed.counts.changedFindings === 0
    ? "No findings on changed files"
    : selectedWarning?.title ?? "No active warnings";
  const topAction = changed && changed.git.available && changed.counts.changedFindings === 0
    ? "The current PR diff has no active Snitch findings. Use the Diagram and Changed views for review; repo-wide warnings remain in the rail below."
    : selectedWarning
    ? selectedWarning.repairPrompt
    : "No active warning selected.";
  const warningDetail = changed?.git.available
    ? `${changed.counts.changedFindings} on changed`
    : `${highWarningCount} high`;
  const summaryLines = compactNarration(diagramSummary ?? narration);

  return (
    <section className="daily-brief" aria-label="Daily Brief">
      <div className="brief-title">
        <p className="eyebrow">Daily brief</p>
        <h2>Current PR sidecar</h2>
        <p className="brief-task">{task}</p>
      </div>

      <div className="brief-metrics" aria-label="Run summary">
        <BriefMetric label="Graph" value={`${graphNodeCount} nodes`} detail={`${graphEdgeCount} edges`} />
        <BriefMetric label="Warnings" value={`${warningCount}`} detail={warningDetail} tone={hasChangedFindings ? "hot" : "clear"} />
        <BriefMetric label="Changed" value={changedLabel} detail={changedDetail} tone={hasChangedFindings ? "hot" : "clear"} />
      </div>

      <ChangedFilesCard changed={changed} />

      <div className="brief-action">
        <p className="eyebrow">Next action</p>
        <strong>{actionTitle}</strong>
        <p>{topAction}</p>
      </div>

      <div className="brief-insight">
        <div className="brief-insight-heading">
          <span>Cerebras {cerebrasStatus}</span>
          <span>Backboard {backboardStatus}</span>
        </div>
        {summaryLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </section>
  );
}

function ChangedFilesCard({ changed }: { changed: ChangedSurfaceView | undefined }) {
  const visibleFiles = changed?.changedFiles.slice(0, 5) ?? [];
  const hiddenCount = changed ? Math.max(0, changed.changedFiles.length - visibleFiles.length) : 0;
  const meta = changed
    ? changed.git.available
      ? changed.git.baseRef
        ? `Against ${changed.git.baseRef}`
        : "Worktree status"
      : changed.git.error ?? "Git unavailable"
    : "Waiting for live changed-file data";

  return (
    <div className="brief-change-list" role="region" aria-label="Changed files">
      <div className="brief-change-heading">
        <p className="eyebrow">Changed files</p>
        <span>{meta}</span>
      </div>
      {visibleFiles.length > 0 ? (
        <ul>
          {visibleFiles.map((file) => (
            <li key={`${file.status}:${file.path}`}>
              <code>{file.status}</code>
              <span>{file.path}</span>
            </li>
          ))}
          {hiddenCount > 0 ? <li className="brief-more">+{hiddenCount} more</li> : null}
        </ul>
      ) : (
        <p className="brief-empty">No changed files detected.</p>
      )}
    </div>
  );
}

function BriefMetric({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "hot" | "clear";
}) {
  return (
    <div className={["brief-metric", tone ? `brief-metric-${tone}` : ""].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
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

function GraphSelectionStrip({
  node,
  edges,
  fallbackWarning,
  cwd
}: {
  node: GraphNode | undefined;
  edges: GraphEdge[];
  fallbackWarning: SnitchWarning | undefined;
  cwd: string | undefined;
}) {
  if (!node && !fallbackWarning) {
    return (
      <div className="map-selection-strip">
        <span className="selection-kicker">Focus</span>
        <span className="selection-title">No graph focus in this snapshot.</span>
      </div>
    );
  }

  if (!node && fallbackWarning) {
    return (
      <div className="map-selection-strip">
        <span className="selection-kicker">Warning</span>
        <span className="selection-title">{fallbackWarning.title}</span>
        <span className="selection-meta">{fallbackWarning.severity}</span>
      </div>
    );
  }

  if (!node) {
    return null;
  }

  const href = editorHref(cwd, node.file, node.line);

  return (
    <div className="map-selection-strip" aria-label="Selected graph node">
      <span className="selection-kicker">{kindLabel(node.kind)}</span>
      <span className="selection-title">{node.label}</span>
      {href && node.file ? (
        <a className="selection-file" href={href}>
          {node.file}
          {node.line ? `:${node.line}` : ""}
        </a>
      ) : node.file ? (
        <span className="selection-file">
          {node.file}
          {node.line ? `:${node.line}` : ""}
        </span>
      ) : null}
      <span className="selection-meta">{edges.length} links</span>
    </div>
  );
}

function kindLabel(kind: GraphNode["kind"]): string {
  return kind === "endpoint" ? "route" : kind;
}

function editorHref(cwd: string | undefined, file: string | undefined, line: number | undefined): string | undefined {
  if (!cwd || !file) {
    return undefined;
  }

  return `vscode://file/${cwd.replace(/\/$/, "")}/${file}${typeof line === "number" ? `:${line}` : ""}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
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

      if (!ranking) {
        return warning;
      }

      if (!ranking.repairPrompt.trim()) {
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
