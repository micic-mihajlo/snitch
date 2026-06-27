import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnitchArtifacts, getDemoReplay, getReviewSnapshot } from "@snitch/graph";
import App from "./App";

describe("Snitch dashboard", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("renders the live tool surface, warning rail, artifact panel, and sponsor lane", () => {
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
          }
        })
      }))
    );

    render(<App />);

    expect(await screen.findByText("live typescript / 2 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay next/i })).toBeDisabled();
    expect(
      within(screen.getByRole("complementary", { name: "Warning Rail" })).getByRole("button", {
        name: /No audit trail for external tool calls/i
      })
    ).toBeInTheDocument();
  });
});
