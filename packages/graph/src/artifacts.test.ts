import { describe, expect, it } from "vitest";
import { buildSnitchArtifacts, getDemoReplay, getReviewSnapshot } from "./index";

describe("buildSnitchArtifacts", () => {
  it("creates durable local artifacts for PR review and handoff", () => {
    const replay = getDemoReplay();
    const reviewSnapshot = getReviewSnapshot(replay);
    const artifacts = buildSnitchArtifacts({
      replay,
      reviewSnapshot,
      createdAt: "2026-06-27T00:00:00.000Z",
      runId: "snitch-demo",
      task:
        "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry."
    });

    expect(Object.keys(artifacts).sort()).toEqual([
      "graph.json",
      "handoff.md",
      "mermaid.mmd",
      "pr-comment.md",
      "session.json",
      "timeline.jsonl"
    ]);
    expect(JSON.parse(artifacts["session.json"]).runId).toBe("snitch-demo");
    expect(JSON.parse(artifacts["graph.json"]).nodes).toHaveLength(
      reviewSnapshot.graph.nodes.length
    );
    expect(artifacts["timeline.jsonl"].split("\n")).toHaveLength(replay.length);
    expect(artifacts["mermaid.mmd"]).toContain("tool_create_issue");
    expect(artifacts["handoff.md"]).toContain("Missing companion warnings");
    expect(artifacts["pr-comment.md"]).toContain("## Snitch Review");
    expect(artifacts["pr-comment.md"]).toContain("```mermaid");
    expect(artifacts["pr-comment.md"]).toContain("No audit trail for external tool calls");
    expect(artifacts["pr-comment.md"]).toContain("Evidence:");
  });
});
