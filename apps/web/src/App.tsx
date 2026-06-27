import { RotateCcw, StepForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildSnitchArtifacts, createStaticNarration, diffGraph } from "@snitch/graph";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { SponsorLane } from "./components/SponsorLane";
import { Timeline } from "./components/Timeline";
import { WarningRail } from "./components/WarningRail";
import { scopeGraph, type GraphScope } from "./lib/graphScope";
import { useLiveSnitch } from "./lib/useLiveSnitch";
import { useReplay } from "./lib/useReplay";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export default function App() {
  const replay = useReplay();
  const live = useLiveSnitch();
  const [createdAt] = useState(() => new Date().toISOString());
  const [graphScope, setGraphScope] = useState<GraphScope>("all");
  const currentSnapshot = live.snapshot ?? replay.currentSnapshot;
  const previousSnapshot = live.previousSnapshot ?? replay.previousSnapshot;
  const visibleSnapshots = live.snapshot ? [currentSnapshot] : replay.snapshots;
  const reviewSnapshot = live.snapshot ?? replay.reviewSnapshot;
  const [selectedWarningId, setSelectedWarningId] = useState<string | undefined>(
    currentSnapshot.warnings[0]?.id
  );
  const selectedWarning =
    currentSnapshot.warnings.find((warning) => warning.id === selectedWarningId) ??
    currentSnapshot.warnings[0];
  const diff = useMemo(
    () => diffGraph(previousSnapshot.graph, currentSnapshot.graph),
    [currentSnapshot, previousSnapshot]
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
    () => createStaticNarration(diff, currentSnapshot.warnings),
    [currentSnapshot.warnings, diff]
  );
  const sponsorLane = live.sponsorLane ?? {
    narration,
    ruleCount: 0,
    cerebrasStatus: "static fallback",
    backboardStatus: "not connected"
  };
  const scopedGraph = useMemo(
    () => scopeGraph(currentSnapshot.graph, diff, graphScope, selectedWarning?.id),
    [currentSnapshot.graph, diff, graphScope, selectedWarning?.id]
  );

  useEffect(() => {
    if (!currentSnapshot.warnings.some((warning) => warning.id === selectedWarningId)) {
      setSelectedWarningId(currentSnapshot.warnings[0]?.id);
    }
  }, [currentSnapshot.warnings, selectedWarningId]);

  function handleNext() {
    if (live.status === "live") {
      return;
    }

    const nextSnapshot = replay.advance();
    setSelectedWarningId(nextSnapshot.warnings[0]?.id);
  }

  function handleReset() {
    if (live.status === "live") {
      return;
    }

    const resetSnapshot = replay.reset();
    setSelectedWarningId(resetSnapshot.warnings[0]?.id);
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

      <section className="workspace-grid" aria-label="Snitch workspace">
        <section className="map-panel" aria-label="Live System Map">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Current graph</p>
              <h2>Live System Map</h2>
            </div>
            <div className="map-tools">
              <div className="segmented-control" aria-label="Graph scope">
                {(["all", "changed", "impacted"] as const).map((scope) => (
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
                {scopedGraph.nodes.length}/{currentSnapshot.graph.nodes.length} nodes · +
                {diff.summary.addedNodes} / +{diff.summary.addedEdges}
              </output>
            </div>
          </div>
          <GraphCanvas graph={scopedGraph} />
        </section>

        <WarningRail
          warnings={currentSnapshot.warnings}
          selectedWarning={selectedWarning}
          onSelect={(warning) => setSelectedWarningId(warning.id)}
        />
      </section>

      <section className="lower-grid" aria-label="Snitch evidence">
        <Timeline
          snapshots={visibleSnapshots}
          currentSnapshotId={currentSnapshot.id}
        />
        <SponsorLane
          narration={sponsorLane.narration}
          ruleCount={sponsorLane.ruleCount}
          cerebrasStatus={sponsorLane.cerebrasStatus}
          backboardStatus={sponsorLane.backboardStatus}
        />
        <ArtifactPanel artifacts={artifacts} />
      </section>
    </main>
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
