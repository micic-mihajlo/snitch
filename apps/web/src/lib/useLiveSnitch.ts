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
  events: LiveSnitchEvent[];
  artifacts: {
    findings?: string;
    mermaid: string;
    prComment: string;
    handoff: string;
    timeline: string;
  };
  insights?: {
    generatedAt: string;
    narration: string;
    cerebras: {
      status: string;
      triageStatus?: string;
      model?: string;
    };
    backboard: {
      status: string;
      rules: string[];
    };
    rankedWarnings: RankedWarningView[];
  };
  memory?: {
    generatedAt: string;
    backboard: {
      status: string;
      rememberedWarnings: number;
    };
  };
};

type LiveSnitchEvent = {
  id: string;
  source: string;
  phase: string;
  hook: string;
  receivedAt: string;
  payloadHash: string;
  payloadBytes: number;
  safeSummary: Record<string, string | number | boolean>;
};

export type RankedWarningView = {
  warningId: string;
  rank: number;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
  repairPrompt: string;
};

type LiveSnitchState = {
  status: "live" | "replay";
  snapshot?: ReplaySnapshot;
  previousSnapshot?: ReplaySnapshot;
  artifacts?: SnitchArtifacts;
  integrationPanel?: {
    narration: string;
    ruleCount: number;
    cerebrasStatus: string;
    backboardStatus: string;
    memoryStatus: string;
  };
  rankedWarnings?: RankedWarningView[];
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
    let eventSource: EventSource | undefined;
    const liveUrl = liveServerUrl();

    if (!liveUrl) {
      return;
    }

    function applyApiState(apiState: LiveApiState): void {
      if (!apiState.ok || disposed) {
        return;
      }

      const snapshot = toSnapshot(apiState);
      const artifacts = toArtifacts(apiState);

      setLiveState((current) => {
        const sameGraph = current.snapshot
          ? graphSignature(current.snapshot.graph) === graphSignature(snapshot.graph)
          : false;
        const nextState: LiveSnitchState = {
          status: "live",
          snapshot,
          previousSnapshot: sameGraph
            ? current.previousSnapshot ?? current.snapshot ?? snapshot
            : current.snapshot ?? snapshot,
          artifacts,
          graphSourceLabel: apiState.session?.graphSource
            ? `live ${apiState.session.graphSource}`
            : "live artifacts"
        };

        if (typeof apiState.session?.eventCount === "number") {
          nextState.eventCount = apiState.session.eventCount;
        }

        if (apiState.insights) {
          nextState.integrationPanel = {
            narration: apiState.insights.narration,
            ruleCount: apiState.insights.backboard.rules.length,
            cerebrasStatus: formatIntegrationStatus(
              apiState.insights.cerebras.status,
              apiState.insights.cerebras.model
            ),
            backboardStatus: apiState.insights.backboard.status,
            memoryStatus: "pending"
          };

          if (apiState.memory) {
            nextState.integrationPanel.memoryStatus = `${apiState.memory.backboard.status} / ${apiState.memory.backboard.rememberedWarnings} memories`;
          }

          nextState.rankedWarnings = apiState.insights.rankedWarnings;
        }

        return nextState;
      });
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
        applyApiState(apiState);
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
    const hasEventSource = typeof EventSource !== "undefined";

    if (hasEventSource) {
      eventSource = new EventSource(`${liveUrl}/api/events`);
      eventSource.addEventListener("state", (event) => {
        try {
          applyApiState(JSON.parse((event as MessageEvent<string>).data) as LiveApiState);
        } catch {
          void refreshLiveState();
        }
      });
      eventSource.addEventListener("error", () => {
        void refreshLiveState();
      });
    }

    const interval = window.setInterval(() => void refreshLiveState(), hasEventSource ? 3000 : 1000);

    return () => {
      disposed = true;
      eventSource?.close();
      window.clearInterval(interval);
    };
  }, []);

  return liveState;
}

function formatIntegrationStatus(status: string, model?: string): string {
  return model ? `${status} · ${model}` : status;
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
    "findings.json": apiState.artifacts.findings ?? "[]",
    "timeline.jsonl": apiState.artifacts.timeline,
    "mermaid.mmd": apiState.artifacts.mermaid,
    "handoff.md": apiState.artifacts.handoff,
    "pr-comment.md": apiState.artifacts.prComment
  };
}

function graphSignature(graph: SnitchGraph): string {
  return JSON.stringify({
    nodes: graph.nodes.map((node) => `${node.id}:${node.hash}`).sort(),
    edges: graph.edges.map((edge) => `${edge.id}:${edge.hash}`).sort()
  });
}
