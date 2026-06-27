import { describe, expect, it } from "vitest";
import { diffGraph, getDemoReplay, type SnitchGraph } from "@snitch/graph";
import { scopeGraph } from "./graphScope";

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

  it("focuses changed mode on graph nodes anchored to changed files", () => {
    const graph: SnitchGraph = {
      id: "repo-graph",
      title: "Repo graph",
      nodes: [
        { id: "service:web", kind: "service", label: "Web app", file: "apps/web/src/App.tsx", hash: "web" },
        { id: "service:cli", kind: "service", label: "CLI", file: "packages/cli/src/cli.ts", hash: "cli" },
        { id: "external:cerebras", kind: "external", label: "Cerebras", hash: "cerebras" },
        { id: "service:unrelated", kind: "service", label: "Unrelated", file: "packages/other/src/index.ts", hash: "other" }
      ],
      edges: [
        { id: "edge:cli-cerebras", from: "service:cli", to: "external:cerebras", kind: "calls", hash: "edge" },
        { id: "edge:web-other", from: "service:web", to: "service:unrelated", kind: "calls", hash: "other-edge" }
      ]
    };
    const scoped = scopeGraph(
      graph,
      diffGraph(graph, graph),
      "changed",
      undefined,
      { changedFiles: ["packages/cli/src/cli.ts"] }
    );

    expect(scoped.nodes.map((node) => node.id)).toEqual(["service:cli", "external:cerebras"]);
    expect(scoped.edges.map((edge) => edge.id)).toEqual(["edge:cli-cerebras"]);
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
