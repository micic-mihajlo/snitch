import { describe, expect, it } from "vitest";
import {
  diffGraph,
  hashEvidence,
  keepLastGoodGraph,
  type SnitchGraph
} from "./index";

const previousGraph: SnitchGraph = {
  id: "demo-run",
  title: "Snitch Demo",
  nodes: [
    {
      id: "agent:router",
      kind: "agent",
      label: "Agent router",
      hash: "router-v1"
    },
    {
      id: "tool:search",
      kind: "tool",
      label: "Search tool",
      hash: "search-v1"
    }
  ],
  edges: [
    {
      id: "edge:router-registers-search",
      from: "agent:router",
      to: "tool:search",
      kind: "registers",
      hash: "registers-v1"
    }
  ]
};

describe("diffGraph", () => {
  it("classifies added, removed, changed, and unchanged graph members by stable id and hash", () => {
    const nextGraph: SnitchGraph = {
      ...previousGraph,
      nodes: [
        {
          id: "tool:search",
          kind: "tool",
          label: "Search tool",
          hash: "search-v2"
        },
        {
          id: "tool:create_issue",
          kind: "tool",
          label: "Create issue tool",
          hash: "issue-tool-v1"
        }
      ],
      edges: [
        {
          id: "edge:router-registers-issue",
          from: "agent:router",
          to: "tool:create_issue",
          kind: "registers",
          hash: "registers-issue-v1"
        },
        {
          id: "edge:router-registers-search",
          from: "agent:router",
          to: "tool:search",
          kind: "registers",
          hash: "registers-v1"
        }
      ]
    };

    const diff = diffGraph(previousGraph, nextGraph);

    expect(diff.addedNodes.map((node) => node.id)).toEqual(["tool:create_issue"]);
    expect(diff.removedNodes.map((node) => node.id)).toEqual(["agent:router"]);
    expect(diff.changedNodes.map((change) => change.next.id)).toEqual(["tool:search"]);
    expect(diff.unchangedNodes.map((node) => node.id)).toEqual([]);
    expect(diff.addedEdges.map((edge) => edge.id)).toEqual(["edge:router-registers-issue"]);
    expect(diff.removedEdges).toEqual([]);
    expect(diff.changedEdges).toEqual([]);
    expect(diff.unchangedEdges.map((edge) => edge.id)).toEqual(["edge:router-registers-search"]);
    expect(diff.summary).toEqual({
      addedNodes: 1,
      removedNodes: 1,
      changedNodes: 1,
      addedEdges: 1,
      removedEdges: 0,
      changedEdges: 0
    });
  });

  it("hashes evidence deterministically regardless of object key order", () => {
    expect(hashEvidence({ b: 2, a: 1 })).toBe(hashEvidence({ a: 1, b: 2 }));
  });
});

describe("keepLastGoodGraph", () => {
  it("preserves the last valid graph when a parse/update event fails", () => {
    const result = keepLastGoodGraph(previousGraph, {
      ok: false,
      source: "extractor-ts",
      error: "Unexpected token while agent was mid-edit"
    });

    expect(result.accepted).toBe(false);
    expect(result.graph).toBe(previousGraph);
    expect(result.warnings).toEqual([
      {
        id: "warning:last_good_graph_retained",
        kind: "warning",
        severity: "info",
        title: "Last valid graph retained",
        message: "extractor-ts failed, so Snitch kept the previous graph visible.",
        evidence: ["Unexpected token while agent was mid-edit"]
      }
    ]);
  });
});
