import { RotateCcw, StepForward } from "lucide-react";
import { useMemo, useState } from "react";
import { buildSnitchArtifacts, createStaticNarration, diffGraph } from "@snitch/graph";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { SponsorLane } from "./components/SponsorLane";
import { Timeline } from "./components/Timeline";
import { WarningRail } from "./components/WarningRail";
import { useReplay } from "./lib/useReplay";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export default function App() {
  const replay = useReplay();
  const [selectedWarningId, setSelectedWarningId] = useState<string | undefined>(
    replay.currentSnapshot.warnings[0]?.id
  );
  const selectedWarning =
    replay.currentSnapshot.warnings.find((warning) => warning.id === selectedWarningId) ??
    replay.currentSnapshot.warnings[0];
  const diff = useMemo(
    () => diffGraph(replay.previousSnapshot.graph, replay.currentSnapshot.graph),
    [replay.currentSnapshot, replay.previousSnapshot]
  );
  const artifacts = useMemo(
    () =>
      buildSnitchArtifacts({
        replay: replay.snapshots,
        reviewSnapshot: replay.reviewSnapshot,
        createdAt: "2026-06-27T00:00:00.000Z",
        runId: "snitch-ui-preview",
        task
      }),
    [replay.reviewSnapshot, replay.snapshots]
  );
  const narration = useMemo(
    () => createStaticNarration(diff, replay.currentSnapshot.warnings),
    [diff, replay.currentSnapshot.warnings]
  );

  function handleNext() {
    const nextSnapshot = replay.advance();
    setSelectedWarningId(nextSnapshot.warnings[0]?.id);
  }

  function handleReset() {
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
          <button type="button" className="tool-button" onClick={handleNext} title="Advance replay">
            <StepForward aria-hidden="true" size={18} />
            Replay next
          </button>
          <button type="button" className="icon-button" onClick={handleReset} title="Reset replay">
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
          <GraphCanvas graph={replay.currentSnapshot.graph} />
        </section>

        <WarningRail
          warnings={replay.currentSnapshot.warnings}
          selectedWarning={selectedWarning}
          onSelect={(warning) => setSelectedWarningId(warning.id)}
        />
      </section>

      <section className="lower-grid" aria-label="Snitch evidence">
        <Timeline
          snapshots={replay.snapshots}
          currentSnapshotId={replay.currentSnapshot.id}
          previousSnapshot={replay.previousSnapshot}
        />
        <SponsorLane narration={narration} ruleCount={2} cerebrasStatus="ready" backboardStatus="memory on" />
        <ArtifactPanel artifacts={artifacts} />
      </section>
    </main>
  );
}
