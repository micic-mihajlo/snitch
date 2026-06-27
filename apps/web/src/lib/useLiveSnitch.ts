import { useEffect, useState } from "react";
import type { ReplaySnapshot, SnitchArtifacts, SnitchGraph, SnitchWarning } from "@snitch/graph";

type LiveApiState = {
  ok: true;
  cwd: string;
  generatedAt: string;
  session: {
    runId?: string;
    task?: string;
    graphSource?: string;
    eventCount?: number;
  } | null;
  graph: SnitchGraph;
  warnings: SnitchWarning[];
  artifacts: {
    mermaid: string;
    prComment: string;
    handoff: string;
    timeline: string;
  };
};

type LiveSnitchState = {
  status: "live" | "replay";
  snapshot?: ReplaySnapshot;
  previousSnapshot?: ReplaySnapshot;
  artifacts?: SnitchArtifacts;
  graphSourceLabel: string;
  eventCount?: number;
};

export function useLiveSnitch(): LiveSnitchState {
  const [liveState, setLiveState] = useState<LiveSnitchState>({
    status: "replay",
    graphSourceLabel: "replay fallback"
  });

  useEffect(() => {
    let disposed = false;
    const liveUrl = liveServerUrl();

    if (!liveUrl) {
      return;
    }

    async function refreshLiveState(): Promise<void> {
      try {
        const response = await fetch(`${liveUrl}/api/state`, {
          cache: "no-store"
        });

        if (!response.ok) {
          return;
        }

        const apiState = (await response.json()) as LiveApiState;

        if (!apiState.ok || disposed) {
          return;
        }

        const snapshot = toSnapshot(apiState);
        const artifacts = toArtifacts(apiState);

        setLiveState((current) => {
          const nextState: LiveSnitchState = {
            status: "live",
            snapshot,
            previousSnapshot: current.snapshot ?? snapshot,
            artifacts,
            graphSourceLabel: apiState.session?.graphSource
              ? `live ${apiState.session.graphSource}`
              : "live artifacts"
          };

          if (typeof apiState.session?.eventCount === "number") {
            nextState.eventCount = apiState.session.eventCount;
          }

          return nextState;
        });
      } catch {
        if (!disposed) {
          setLiveState((current) =>
            current.status === "live"
              ? current
              : {
                  status: "replay",
                  graphSourceLabel: "replay fallback"
                }
          );
        }
      }
    }

    void refreshLiveState();
    const interval = window.setInterval(() => void refreshLiveState(), 1000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  return liveState;
}

function liveServerUrl(): string | undefined {
  const queryUrl = new URLSearchParams(window.location.search).get("snitchLive") ?? undefined;

  return queryUrl === "default"
    ? "http://127.0.0.1:4767"
    : queryUrl ?? import.meta.env.VITE_SNITCH_LIVE_URL;
}

function toSnapshot(apiState: LiveApiState): ReplaySnapshot {
  return {
    id: apiState.graph.id,
    title: apiState.graph.title,
    description: `Live Snitch artifacts from ${apiState.cwd}`,
    graph: apiState.graph,
    warnings: apiState.warnings
  };
}

function toArtifacts(apiState: LiveApiState): SnitchArtifacts {
  return {
    "session.json": JSON.stringify(apiState.session ?? {}, null, 2),
    "graph.json": JSON.stringify(apiState.graph, null, 2),
    "warnings.json": JSON.stringify(apiState.warnings, null, 2),
    "timeline.jsonl": apiState.artifacts.timeline,
    "mermaid.mmd": apiState.artifacts.mermaid,
    "handoff.md": apiState.artifacts.handoff,
    "pr-comment.md": apiState.artifacts.prComment
  };
}
