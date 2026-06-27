import { getDemoReplay, getReviewSnapshot, type ReplaySnapshot } from "@snitch/graph";
import { useMemo, useState } from "react";

export function useReplay() {
  const snapshots = useMemo(() => getDemoReplay(), []);
  const reviewSnapshot = useMemo(() => getReviewSnapshot(snapshots), [snapshots]);
  const reviewIndex = Math.max(
    0,
    snapshots.findIndex((snapshot) => snapshot.id === reviewSnapshot.id)
  );
  const [index, setIndex] = useState(reviewIndex);
  const currentSnapshot = requiredSnapshot(snapshots[index], "current");
  const previousSnapshot = snapshots[index - 1] ?? currentSnapshot;

  function advance(): ReplaySnapshot {
    const nextIndex = (index + 1) % snapshots.length;
    const nextSnapshot = requiredSnapshot(snapshots[nextIndex], "next");
    setIndex(nextIndex);
    return nextSnapshot;
  }

  function reset(): ReplaySnapshot {
    const nextSnapshot = requiredSnapshot(snapshots[reviewIndex], "review");
    setIndex(reviewIndex);
    return nextSnapshot;
  }

  return {
    snapshots,
    currentSnapshot,
    previousSnapshot,
    reviewSnapshot,
    advance,
    reset
  };
}

function requiredSnapshot(snapshot: ReplaySnapshot | undefined, name: string): ReplaySnapshot {
  if (!snapshot) {
    throw new Error(`Missing ${name} replay snapshot.`);
  }

  return snapshot;
}
