import { describe, expect, it } from "vitest";
import { diffGraph } from "./diff";
import { getDemoReplay } from "./replay";
import { scopeGraph } from "./scope";

describe("scopeGraph", () => {
  it("keeps the full graph in all mode", () => {
    const snapshot = getDemoReplay()[3]!;
    const scoped = scopeGraph(snapshot.graph, diffGraph(snapshot.graph, snapshot.graph), "all");

    expect(scoped.nodes).toHaveLength(snapshot.graph.nodes.length);
    expect(scoped.edges).toHaveLength(snapshot.graph.edges.length);
  });

  it("focuses changed mode on new warning nodes and edges", () => {
    const replay = getDemoReplay();
    const previous = replay[2]!;
    const next = replay[3]!;
    const scoped = scopeGraph(next.graph, diffGraph(previous.graph, next.graph), "changed");

    expect(scoped.nodes.map((node) => node.id)).toContain(
      "warning:tool_audit_log_missing:create_issue"
    );
    expect(scoped.nodes.length).toBeLessThan(next.graph.nodes.length);
    expect(scoped.edges.every((edge) => edge.kind === "missing")).toBe(true);
  });

  it("focuses impacted mode around the selected warning neighborhood", () => {
    const snapshot = getDemoReplay()[3]!;
    const scoped = scopeGraph(
      snapshot.graph,
      diffGraph(snapshot.graph, snapshot.graph),
      "impacted",
      "warning:secret_redaction_missing:create_issue"
    );

    expect(scoped.nodes.map((node) => node.id)).toContain("tool:create_issue");
    expect(scoped.nodes.map((node) => node.id)).toContain(
      "warning:secret_redaction_missing:create_issue"
    );
    expect(scoped.nodes.map((node) => node.id)).not.toContain(
      "warning:unauthorized_test_missing:create_issue"
    );
  });
});
