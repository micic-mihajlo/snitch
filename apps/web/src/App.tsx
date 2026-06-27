import { RotateCcw, StepForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildSnitchArtifacts, createStaticNarration, diffGraph } from "@snitch/graph";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { SponsorLane } from "./components/SponsorLane";
import { Timeline } from "./components/Timeline";
import { WarningRail } from "./components/WarningRail";
import { useLiveSnitch } from "./lib/useLiveSnitch";
import { useReplay } from "./lib/useReplay";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export default function App() {
  const replay = useReplay();
  const live = useLiveSnitch();
  const [createdAt] = useState(() => new Date().toISOString());
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
            <output className="diff-meter">
              +{diff.summary.addedNodes} nodes / +{diff.summary.addedEdges} edges
            </output>
          </div>
          <GraphCanvas graph={currentSnapshot.graph} />
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
          narration={narration}
          ruleCount={0}
          cerebrasStatus="static fallback"
          backboardStatus="not connected"
        />
        <ArtifactPanel artifacts={artifacts} />
      </section>
    </main>
  );
}
