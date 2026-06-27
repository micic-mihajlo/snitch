import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByText("Cerebras Diagram")).toBeInTheDocument();
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
    expect(screen.getByLabelText("Selected graph node")).toHaveTextContent(
      "No audit trail for external tool calls"
    );
  });

  it("keeps warning rail selection and graph focus together", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /No per-session permission boundary/i }));

    expect(screen.getByLabelText("Selected graph node")).toHaveTextContent(
      "No per-session permission boundary"
    );
  });

  it("advances replay without blanking the graph", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Replay next/i }));

    expect(screen.getByText("Cerebras Diagram")).toBeInTheDocument();
    expect(screen.getByText("Create issue tool")).toBeInTheDocument();
  });

  it("can scope the graph to the selected warning impact", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText("Cerebras Diagram")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Impact" }));

    expect(screen.getByText("Live System Map")).toBeInTheDocument();
    expect(screen.getByText(/6\/10 nodes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Impact" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("switches from replay fallback to live Snitch artifacts", async () => {
    const replay = getDemoReplay();
    const snapshot = withToolAnchor(getReviewSnapshot(replay));
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
          changed: {
            target: "apps/demo-app",
            git: {
              available: true,
              baseRef: "origin/main",
              diffMode: "base"
            },
            changedFiles: [
              {
                path: "apps/demo-app/src/tools/create-issue.ts",
                status: "M",
                targetPath: "src/tools/create-issue.ts",
                inAnalysisTarget: true
              },
              {
                path: "README.md",
                status: "M",
                inAnalysisTarget: false
              }
            ],
            changedFindings: [
              {
                finding: {
                  warningId: "warning:tool_audit_log_missing:create_issue",
                  title: "No audit trail for external tool calls",
                  severity: "high"
                },
                matchedFiles: ["src/tools/create-issue.ts"]
              }
            ],
            counts: {
              changedFiles: 2,
              targetChangedFiles: 1,
              activeFindings: snapshot.warnings.length,
              changedFindings: 1
            },
            nextCommands: ["pnpm snitch trace --warning warning:tool_audit_log_missing:create_issue --json"]
          },
          artifacts: {
            mermaid: artifacts["mermaid.mmd"],
            prComment: artifacts["pr-comment.md"],
            handoff: artifacts["handoff.md"],
            timeline: artifacts["timeline.jsonl"]
          },
          diagram: {
            generatedAt: "2026-06-27T12:00:00.000Z",
            source: "cerebras",
            status: "ok",
            summary: "Cerebras selected the issue-tool path for review.",
            model: "glm-5.1",
            graph: snapshot.graph
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
      within(screen.getByRole("region", { name: "Selected repair prompt" })).getByText(
        "Gate create_issue behind a session-scoped permission check."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Daily Brief" })).toHaveTextContent(
      "2 changed / 1 flagged"
    );
    expect(screen.getByRole("region", { name: "Daily Brief" })).toHaveTextContent("vs origin/main");
    expect(screen.getByRole("region", { name: "Changed files" })).toHaveTextContent(
      "apps/demo-app/src/tools/create-issue.ts"
    );
    expect(screen.getByText("Cerebras Diagram")).toBeInTheDocument();
    expect(screen.getByText("ok · glm-5.1 · 10 nodes")).toBeInTheDocument();
    expect(screen.getAllByText("Cerebras selected the issue-tool path for review.").length).toBeGreaterThan(0);
    expect(screen.getByText("ok · glm-5.1")).toBeInTheDocument();
    expect(screen.getByText("ok / 2 repo rules")).toBeInTheDocument();
    expect(screen.getByText(/memory: ok \/ 2 memories/)).toBeInTheDocument();
    expect(screen.getAllByText(/Cerebras says the issue tool/i).length).toBeGreaterThan(0);

    fireEvent.click(within(screen.getByTestId("graph-frame")).getByText("Create issue tool"));
    const selectedNode = screen.getByLabelText("Selected graph node");
    expect(selectedNode).toHaveTextContent("Create issue tool");
    expect(
      within(selectedNode).getByRole("link", { name: "src/assistant/tools.ts:42" })
    ).toHaveAttribute("href", "vscode://file//tmp/snitch-live/src/assistant/tools.ts:42");
  });

  it("keeps action panels readable when a warning lacks a repair prompt", async () => {
    const replay = getDemoReplay();
    const snapshot = withoutWarningRepairPrompts(getReviewSnapshot(replay));
    const firstWarning = snapshot.warnings[0];

    if (!firstWarning) {
      throw new Error("Demo replay is missing warnings.");
    }

    window.history.replaceState(null, "", "/?snitchLive=http://127.0.0.1:4767");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => liveApiStateFor(snapshot, 1)
      }))
    );

    render(<App />);

    expect(await screen.findByRole("region", { name: "Daily Brief" })).toHaveTextContent(
      firstWarning.message
    );
    expect(screen.getByRole("region", { name: "Selected repair prompt" })).toHaveTextContent(
      firstWarning.message
    );
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
    expect(screen.getByText("ok · glm-5.1 · 10 nodes")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /No audit trail for external tool calls/i })
    ).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit("state", liveApiStateFor(reviewSnapshot, 2));
    });

    expect(screen.getByText("ok · glm-5.1 · 10 nodes")).toBeInTheDocument();
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
    diagram: {
      generatedAt: "2026-06-27T12:00:00.000Z",
      source: "cerebras",
      status: "ok",
      summary: "Cerebras selected the current issue-tool path.",
      model: "glm-5.1",
      graph: snapshot.graph
    },
    changed: {
      ok: true,
      cwd: "/tmp/snitch-live",
      generatedAt: "2026-06-27T12:00:00.000Z",
      target: "apps/demo-app",
      git: {
        available: true,
        baseRef: "origin/main",
        diffMode: "base"
      },
      changedFiles: [
        {
          path: "apps/demo-app/src/tools/create-issue.ts",
          status: "M",
          targetPath: "src/tools/create-issue.ts",
          inAnalysisTarget: true
        },
        {
          path: "README.md",
          status: "M",
          inAnalysisTarget: false
        }
      ],
      changedFindings: [
        {
          finding: {
            warningId: "warning:tool_audit_log_missing:create_issue",
            title: "No audit trail for external tool calls",
            severity: "high"
          },
          matchedFiles: ["src/tools/create-issue.ts"]
        }
      ],
      counts: {
        changedFiles: 2,
        targetChangedFiles: 1,
        activeFindings: snapshot.warnings.length,
        changedFindings: 1
      },
      nextCommands: ["pnpm snitch trace --warning warning:tool_audit_log_missing:create_issue --json"]
    },
    artifacts: {
      mermaid: artifacts["mermaid.mmd"],
      prComment: artifacts["pr-comment.md"],
      handoff: artifacts["handoff.md"],
      timeline: artifacts["timeline.jsonl"]
    }
  };
}

function withToolAnchor(snapshot: ReplaySnapshot): ReplaySnapshot {
  return {
    ...snapshot,
    graph: {
      ...snapshot.graph,
      nodes: snapshot.graph.nodes.map((node) =>
        node.id === "tool:create_issue"
          ? {
              ...node,
              file: "src/assistant/tools.ts",
              line: 42
            }
          : node
      )
    }
  };
}

function withoutWarningRepairPrompts(snapshot: ReplaySnapshot): ReplaySnapshot {
  return {
    ...snapshot,
    warnings: snapshot.warnings.map((warning) => ({
      id: warning.id,
      kind: warning.kind,
      severity: warning.severity,
      title: warning.title,
      message: warning.message,
      evidence: warning.evidence
    }))
  };
}
