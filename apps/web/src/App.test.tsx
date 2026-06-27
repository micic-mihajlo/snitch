import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnitchArtifacts, getDemoReplay, getReviewSnapshot, type ReplaySnapshot } from "@snitch/graph";
import App from "./App";

describe("Snitch dashboard", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("renders the live tool surface, warning rail, artifact panel, and integration panel", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Snitch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay next/i })).toBeInTheDocument();
    expect(screen.getByText("Live System Map")).toBeInTheDocument();
    expect(screen.getByText("Warning Rail")).toBeInTheDocument();
    expect(screen.getByText("PR Artifact")).toBeInTheDocument();
    expect(screen.getByText("Cerebras")).toBeInTheDocument();
    expect(screen.getByText("Backboard")).toBeInTheDocument();
    expect(screen.getByText("static fallback")).toBeInTheDocument();
    expect(screen.getByText("not connected / 0 repo rules")).toBeInTheDocument();
    expect(screen.getByText("Create issue tool")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /No audit trail for external tool calls/i })
    ).toBeInTheDocument();
  });

  it("shows a repair prompt when a warning is clicked", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /No audit trail for external tool calls/i }));

    expect(
      within(screen.getByRole("region", { name: "Selected repair prompt" })).getByText(
        /Add an audit log write around create_issue calls/i
      )
    ).toBeInTheDocument();
  });

  it("advances replay without blanking the graph", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Replay next/i }));

    expect(screen.getByText("Live System Map")).toBeInTheDocument();
    expect(screen.getByText("Create issue tool")).toBeInTheDocument();
  });

  it("can scope the graph to the selected warning impact", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText(/10\/10 nodes/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Impact" }));

    expect(screen.getByText(/6\/10 nodes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Impact" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("switches from replay fallback to live Snitch artifacts", async () => {
    const replay = getDemoReplay();
    const snapshot = getReviewSnapshot(replay);
    const artifacts = buildSnitchArtifacts({
      replay: [snapshot],
      reviewSnapshot: snapshot,
      createdAt: "2026-06-27T12:00:00.000Z",
      runId: "snitch-live-test",
      task: "Wire an issue tool",
      source: "snitch-ts-extractor"
    });

    window.history.replaceState(null, "", "/?snitchLive=http://127.0.0.1:4767");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          cwd: "/tmp/snitch-live",
          generatedAt: "2026-06-27T12:00:00.000Z",
          session: {
            runId: "snitch-live-test",
            task: "Wire an issue tool",
            graphSource: "typescript",
            eventCount: 2
          },
          graph: snapshot.graph,
          warnings: snapshot.warnings,
          artifacts: {
            mermaid: artifacts["mermaid.mmd"],
            prComment: artifacts["pr-comment.md"],
            handoff: artifacts["handoff.md"],
            timeline: artifacts["timeline.jsonl"]
          },
          insights: {
            generatedAt: "2026-06-27T12:00:00.000Z",
            narration: "Cerebras says the issue tool added an external API path.",
            cerebras: {
              status: "ok",
              triageStatus: "ok",
              model: "glm-5.1"
            },
            backboard: {
              status: "ok",
              rules: ["External tools require audit logs.", "Secrets must be redacted."]
            },
            rankedWarnings: [
              {
                warningId: "warning:permission_scope_missing:create_issue",
                rank: 1,
                priority: "critical",
                reason: "Provider write is exposed without a scoped grant.",
                repairPrompt: "Gate create_issue behind a session-scoped permission check."
              },
              {
                warningId: "warning:tool_audit_log_missing:create_issue",
                rank: 2,
                priority: "high",
                reason: "External provider calls need an audit trail.",
                repairPrompt: "Write a redacted audit record for every create_issue call."
              }
            ]
          },
          memory: {
            generatedAt: "2026-06-27T12:05:00.000Z",
            backboard: {
              status: "ok",
              rememberedWarnings: 2
            }
          }
        })
      }))
    );

    render(<App />);

    expect(await screen.findByText("live typescript / 2 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay next/i })).toBeDisabled();
    const topRankedWarning = within(
      screen.getByRole("complementary", { name: "Warning Rail" })
    ).getByRole("button", {
      name: /#1 critical.*No per-session permission boundary/i
    });
    expect(topRankedWarning).toBeInTheDocument();
    await userEvent.click(topRankedWarning);
    expect(screen.getByText("Provider write is exposed without a scoped grant.")).toBeInTheDocument();
    expect(
      screen.getByText("Gate create_issue behind a session-scoped permission check.")
    ).toBeInTheDocument();
    expect(screen.getByText("ok · glm-5.1")).toBeInTheDocument();
    expect(screen.getByText("ok / 2 repo rules")).toBeInTheDocument();
    expect(screen.getByText(/memory: ok \/ 2 memories/)).toBeInTheDocument();
    expect(screen.getByText(/Cerebras says the issue tool/i)).toBeInTheDocument();
  });

  it("updates live Snitch artifacts from server-sent state events", async () => {
    const replay = getDemoReplay();
    const initialSnapshot = replay[0];
    const reviewSnapshot = getReviewSnapshot(replay);

    if (!initialSnapshot) {
      throw new Error("Demo replay is missing the initial snapshot.");
    }

    class MockEventSource {
      static instances: MockEventSource[] = [];

      listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      closed = false;

      constructor(public url: string) {
        MockEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      close() {
        this.closed = true;
      }

      emit(type: string, data: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(data) } as MessageEvent<string>);
        }
      }
    }

    window.history.replaceState(null, "", "/?snitchLive=http://127.0.0.1:4767");
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => liveApiStateFor(initialSnapshot, 1)
      }))
    );

    render(<App />);

    expect(await screen.findByText("live typescript / 1 events")).toBeInTheDocument();
    expect(MockEventSource.instances[0]?.url).toBe("http://127.0.0.1:4767/api/events");

    act(() => {
      MockEventSource.instances[0]?.emit("state", liveApiStateFor(reviewSnapshot, 2));
    });

    expect(await screen.findByText("live typescript / 2 events")).toBeInTheDocument();
    expect(screen.getByText("10/10 nodes · +8 / +8")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /No audit trail for external tool calls/i })
    ).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit("state", liveApiStateFor(reviewSnapshot, 2));
    });

    expect(screen.getByText("10/10 nodes · +8 / +8")).toBeInTheDocument();
  });
});

function liveApiStateFor(snapshot: ReplaySnapshot, eventCount: number) {
  const artifacts = buildSnitchArtifacts({
    replay: [snapshot],
    reviewSnapshot: snapshot,
    createdAt: "2026-06-27T12:00:00.000Z",
    runId: "snitch-live-test",
    task: "Wire an issue tool",
    source: "snitch-ts-extractor"
  });

  return {
    ok: true,
    cwd: "/tmp/snitch-live",
    generatedAt: "2026-06-27T12:00:00.000Z",
    session: {
      runId: "snitch-live-test",
      task: "Wire an issue tool",
      graphSource: "typescript",
      eventCount
    },
    graph: snapshot.graph,
    warnings: snapshot.warnings,
    artifacts: {
      mermaid: artifacts["mermaid.mmd"],
      prComment: artifacts["pr-comment.md"],
      handoff: artifacts["handoff.md"],
      timeline: artifacts["timeline.jsonl"]
    }
  };
}
