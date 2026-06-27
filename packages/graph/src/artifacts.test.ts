import { describe, expect, it } from "vitest";
import {
  buildSnitchArtifacts,
  getDemoReplay,
  getReviewSnapshot,
  hashEvidence,
  snitchArtifactNames
} from "./index";
import type { GraphEdge, GraphNode, ReplaySnapshot, SnitchGraph } from "./types";

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

    expect(Object.keys(artifacts).sort()).toEqual([...snitchArtifactNames].sort());
    expect(JSON.parse(artifacts["session.json"]).runId).toBe("snitch-demo");
    expect(JSON.parse(artifacts["graph.json"]).nodes).toHaveLength(
      reviewSnapshot.graph.nodes.length
    );
    expect(JSON.parse(artifacts["warnings.json"])).toHaveLength(reviewSnapshot.warnings.length);
    expect(JSON.parse(artifacts["findings.json"])[0]).toMatchObject({
      warningId: "warning:tool_audit_log_missing:create_issue"
    });
    expect(JSON.parse(artifacts["briefing.json"])).toMatchObject({
      status: "action_required",
      action: {
        topFinding: {
          warningId: "warning:tool_audit_log_missing:create_issue"
        }
      }
    });
    expect(artifacts["briefing.md"]).toContain("Snitch briefing");
    expect(artifacts["briefing.md"]).toContain("warning:tool_audit_log_missing:create_issue");
    expect(artifacts["timeline.jsonl"].split("\n")).toHaveLength(replay.length);
    expect(artifacts["mermaid.mmd"]).toContain("tool_create_issue");
    expect(artifacts["handoff.md"]).toContain("## Active warnings");
    expect(artifacts["handoff.md"]).toContain("- Tools: Create issue tool");
    expect(artifacts["handoff.md"]).toContain("- Environment: ISSUE_PROVIDER_API_KEY");
    expect(artifacts["next-action.md"]).toContain("Snitch Next Action");
    expect(artifacts["next-action.md"]).toContain("Status: action_required");
    expect(artifacts["next-action.md"]).toContain("pnpm snitch repair-prompt --warning");
    expect(artifacts["pr-comment.md"]).toContain("## Snitch Review");
    expect(artifacts["pr-comment.md"]).toContain("### System Impact");
    expect(artifacts["pr-comment.md"]).toContain("- Active warnings: 4 (2 high, 2 medium)");
    expect(artifacts["pr-comment.md"]).toContain("```mermaid");
    expect(artifacts["pr-comment.md"]).toContain("No audit trail for external tool calls");
    expect(artifacts["pr-comment.md"]).toContain("Evidence:");
    expect(artifacts["pr-comment.md"]).toContain("### Review Findings");
    expect(artifacts["pr-comment.md"]).toContain("warning:tool_audit_log_missing:create_issue");
  });

  it("summarizes the actual graph instead of hardcoded demo copy", () => {
    const reviewSnapshot = snapshot(
      "billing-route",
      "Billing route",
      createGraph(
        [
          node("endpoint:POST:/api/billing", "endpoint", "POST /api/billing", {
            file: "src/app/api/billing/route.ts",
            line: 3
          }),
          node("database:prisma_invoice", "database", "Invoice prisma write", {
            file: "src/app/api/billing/route.ts",
            line: 8
          }),
          node("external:api.stripe.com", "external", "api.stripe.com API", {
            file: "src/app/api/billing/route.ts",
            line: 12
          })
        ],
        [
          edge(
            "edge:billing-writes-invoice",
            "endpoint:POST:/api/billing",
            "database:prisma_invoice",
            "writes"
          ),
          edge(
            "edge:billing-calls-stripe",
            "endpoint:POST:/api/billing",
            "external:api.stripe.com",
            "calls"
          )
        ]
      )
    );
    const artifacts = buildSnitchArtifacts({
      replay: [reviewSnapshot],
      reviewSnapshot,
      createdAt: "2026-06-27T00:00:00.000Z",
      runId: "snitch-billing",
      task: "Add billing route"
    });

    expect(artifacts["pr-comment.md"]).toContain("- Endpoints: POST /api/billing");
    expect(artifacts["pr-comment.md"]).toContain("- External systems: api.stripe.com API");
    expect(artifacts["pr-comment.md"]).toContain("- Data stores: Invoice prisma write");
    expect(artifacts["pr-comment.md"]).toContain("- Active warnings: none");
    expect(artifacts["pr-comment.md"]).not.toContain("issue-creation capability");
    expect(JSON.parse(artifacts["briefing.json"])).toMatchObject({
      status: "clear",
      counts: {
        warnings: 0
      }
    });
    expect(artifacts["briefing.md"]).toContain("- Status: clear");
  });
});

function snapshot(id: string, title: string, graph: SnitchGraph): ReplaySnapshot {
  return {
    id,
    title,
    description: title,
    graph,
    warnings: []
  };
}

function createGraph(nodes: GraphNode[], edges: GraphEdge[]): SnitchGraph {
  return {
    id: "test-graph",
    title: "Test graph",
    nodes,
    edges
  };
}

function node(
  id: GraphNode["id"],
  kind: GraphNode["kind"],
  label: GraphNode["label"],
  input: { file: string; line: number }
): GraphNode {
  return {
    id,
    kind,
    label,
    file: input.file,
    line: input.line,
    hash: hashEvidence({ id, kind, label, input })
  };
}

function edge(id: string, from: string, to: string, kind: GraphEdge["kind"]): GraphEdge {
  return {
    id,
    from,
    to,
    kind,
    hash: hashEvidence({ id, from, to, kind })
  };
}
