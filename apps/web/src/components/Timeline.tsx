import { diffGraph, type ReplaySnapshot } from "@snitch/graph";

type Props = {
  snapshots: ReplaySnapshot[];
  currentSnapshotId: string;
};

export function Timeline({ snapshots, currentSnapshotId }: Props) {
  return (
    <section className="timeline-panel" aria-label="Graph diff timeline">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Replay</p>
          <h2>Timeline</h2>
        </div>
      </div>
      <ol className="timeline-list">
        {snapshots.map((snapshot, index) => {
          const previousSnapshot = snapshots[index - 1] ?? snapshot;
          const diff = diffGraph(previousSnapshot.graph, snapshot.graph);
          return (
            <li key={snapshot.id} className={snapshot.id === currentSnapshotId ? "active" : undefined}>
              <strong>{snapshot.title}</strong>
              <span>
                +{diff.summary.addedNodes} nodes / {snapshot.warnings.length} warnings
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
