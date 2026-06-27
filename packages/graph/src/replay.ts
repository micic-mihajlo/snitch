import { hashEvidence } from "./diff";
import type { GraphEdge, GraphNode, ReplaySnapshot, SnitchGraph, SnitchWarning } from "./types";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export function getDemoReplay(): ReplaySnapshot[] {
  const baseline = createGraph(
    "baseline",
    "Assistant baseline",
    [
      node("agent:router", "agent", "Agent router", { role: "routes assistant requests" }),
      node("service:tool_registry", "service", "Tool registry", {
        role: "exposes callable assistant tools"
      })
    ],
    [edge("edge:router-uses-registry", "agent:router", "service:tool_registry", "calls")]
  );

  const issueTool = createGraph(
    "issue-tool-registered",
    "Issue tool registered",
    [
      ...baseline.nodes,
      node("tool:create_issue", "tool", "Create issue tool", {
        capability: "external issue creation"
      })
    ],
    [
      ...baseline.edges,
      edge(
        "edge:registry-registers-create-issue",
        "service:tool_registry",
        "tool:create_issue",
        "registers"
      )
    ]
  );

  const providerWired = createGraph(
    "provider-wired",
    "Provider client wired",
    [
      ...issueTool.nodes,
      node("schema:create_issue_input", "schema", "CreateIssueInput schema", {
        fields: ["title", "body", "labels"]
      }),
      node("external:issue_provider", "external", "Issue provider API", {
        host: "api.issue-provider.local"
      }),
      node("env:ISSUE_PROVIDER_API_KEY", "env", "ISSUE_PROVIDER_API_KEY", {
        exposure: "server"
      })
    ],
    [
      ...issueTool.edges,
      edge("edge:create-issue-validates-input", "tool:create_issue", "schema:create_issue_input", "validates"),
      edge("edge:create-issue-calls-provider", "tool:create_issue", "external:issue_provider", "calls"),
      edge(
        "edge:create-issue-uses-provider-key",
        "tool:create_issue",
        "env:ISSUE_PROVIDER_API_KEY",
        "uses_secret"
      )
    ]
  );

  const warnings = createMissingCompanionWarnings();
  const warningGraph = createGraph(
    "missing-companions",
    "Missing companion checks",
    [
      ...providerWired.nodes,
      ...warnings.map((warning) =>
        node(warning.id, "warning", warning.title, {
          severity: warning.severity,
          evidence: warning.evidence
        })
      )
    ],
    [
      ...providerWired.edges,
      ...warnings.map((warning) =>
        edge(`edge:${warning.id}:missing`, "tool:create_issue", warning.id, "missing")
      )
    ]
  );

  const repairedGraph = createGraph(
    "repaired-companions",
    "Companions repaired",
    [
      ...providerWired.nodes,
      node("service:tool_audit_log", "service", "Tool audit log", {
        records: "external tool calls"
      }),
      node("service:secret_redactor", "service", "Secret redactor", {
        scope: "tool inputs and outputs"
      }),
      node("contract:issue_tool_permission_scope", "contract", "Per-session permission scope", {
        rule: "external issue creation requires scoped approval"
      }),
      node("test:issue_tool_rejects_unauthorized", "test", "Rejects unauthorized issue calls", {
        file: "tests/issue-tool.test.ts"
      })
    ],
    [
      ...providerWired.edges,
      edge("edge:create-issue-writes-audit", "tool:create_issue", "service:tool_audit_log", "writes"),
      edge("edge:create-issue-calls-redactor", "tool:create_issue", "service:secret_redactor", "calls"),
      edge(
        "edge:create-issue-satisfies-permission",
        "tool:create_issue",
        "contract:issue_tool_permission_scope",
        "satisfies"
      ),
      edge("edge:test-covers-create-issue", "test:issue_tool_rejects_unauthorized", "tool:create_issue", "covers")
    ]
  );

  return [
    snapshot("baseline", "Baseline", "Assistant has a router and tool registry.", baseline, []),
    snapshot("issue-tool", "Issue tool appears", "The agent registers a new external capability.", issueTool, []),
    snapshot(
      "provider-wired",
      "Provider wiring appears",
      "The tool now validates input, calls an external provider, and reads a server credential.",
      providerWired,
      []
    ),
    snapshot(
      "missing-companions",
      "Snitch catches missing companions",
      "The graph gained an external capability but lacks audit, redaction, permission scope, and unauthorized-call coverage.",
      warningGraph,
      warnings
    ),
    snapshot(
      "repaired-companions",
      "Companion work repaired",
      "The follow-up adds the missing audit, redaction, permission, and test companions.",
      repairedGraph,
      []
    )
  ];
}

export function getReviewSnapshot(replay: ReplaySnapshot[] = getDemoReplay()): ReplaySnapshot {
  const reviewSnapshot = replay.find((snapshotItem) => snapshotItem.id === "missing-companions");

  if (!reviewSnapshot) {
    throw new Error("Demo replay is missing the review snapshot.");
  }

  return reviewSnapshot;
}

export function createMissingCompanionWarnings(): SnitchWarning[] {
  return [
    warning(
      "warning:tool_audit_log_missing:create_issue",
      "high",
      "No audit trail for external tool calls",
      "The issue tool calls an external provider but no audit log node writes the call record.",
      [
        "tool:create_issue -> external:issue_provider",
        "No service:tool_audit_log node satisfies this capability."
      ],
      "Add an audit log write around create_issue calls. Record caller, task/session id, provider target, redacted payload summary, status, and timestamp."
    ),
    warning(
      "warning:secret_redaction_missing:create_issue",
      "high",
      "No secret redaction around provider data",
      "The tool uses a provider credential but no redaction service is connected to tool input or output.",
      [
        "tool:create_issue -> env:ISSUE_PROVIDER_API_KEY",
        "No service:secret_redactor node is called by tool:create_issue."
      ],
      "Add a redaction boundary before audit logging and before returning provider errors to the assistant transcript."
    ),
    warning(
      "warning:permission_scope_missing:create_issue",
      "medium",
      "No per-session permission boundary",
      "The registry exposes issue creation without a scoped permission contract for this task or session.",
      [
        "service:tool_registry registers tool:create_issue",
        "No contract:issue_tool_permission_scope node satisfies tool:create_issue."
      ],
      "Require a scoped permission grant before create_issue can call the provider. Tie the grant to this task/session."
    ),
    warning(
      "warning:unauthorized_test_missing:create_issue",
      "medium",
      "No unauthorized-call test",
      "The graph has no test proving the issue tool rejects unauthorized callers.",
      [
        "tool:create_issue has no covers edge from a test node",
        "Expected test:issue_tool_rejects_unauthorized is absent."
      ],
      "Add a test that calls create_issue without permission and asserts that no provider request is made."
    )
  ];
}

function snapshot(
  id: string,
  title: string,
  description: string,
  graph: SnitchGraph,
  warnings: SnitchWarning[]
): ReplaySnapshot {
  return { id, title, description, graph, warnings };
}

function createGraph(id: string, title: string, nodes: GraphNode[], edges: GraphEdge[]): SnitchGraph {
  return {
    id,
    title,
    nodes,
    edges,
    meta: {
      task
    }
  };
}

function node(
  id: GraphNode["id"],
  kind: GraphNode["kind"],
  label: GraphNode["label"],
  meta: Record<string, unknown>
): GraphNode {
  return {
    id,
    kind,
    label,
    meta,
    hash: hashEvidence({ id, kind, label, meta })
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

function warning(
  id: string,
  severity: SnitchWarning["severity"],
  title: string,
  message: string,
  evidence: string[],
  repairPrompt: string
): SnitchWarning {
  return {
    id,
    kind: "warning",
    severity,
    title,
    message,
    evidence,
    repairPrompt
  };
}
