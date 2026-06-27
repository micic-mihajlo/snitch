import { describe, expect, it } from "vitest";
import { getDemoReplay, getReviewSnapshot } from "./replay";
import { verifyIntentCoverage } from "./intent";
import type { SnitchGraph } from "./types";

describe("verifyIntentCoverage", () => {
  it("marks the unsafe issue-tool demo as partially covered with missing companion work", () => {
    const snapshot = getReviewSnapshot(getDemoReplay());
    const coverage = verifyIntentCoverage(
      snapshot.graph,
      snapshot.warnings,
      "Add an external issue creation tool"
    );

    expect(coverage.status).toBe("partial");
    expect(coverage.capabilities).toContainEqual(
      expect.objectContaining({
        id: "issue_creation"
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:tool",
        status: "met",
        matchedNodeIds: ["tool:create_issue"]
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:audit",
        status: "missing"
      })
    );
    expect(coverage.relatedWarnings.map((warning) => warning.id)).toContain(
      "warning:tool_audit_log_missing:create_issue"
    );
  });

  it("marks the repaired issue-tool graph as covered", () => {
    const repaired = getDemoReplay().find((snapshot) => snapshot.id === "repaired-companions");

    if (!repaired) {
      throw new Error("missing repaired demo snapshot");
    }

    const coverage = verifyIntentCoverage(
      repaired.graph,
      repaired.warnings,
      "Add an external issue creation tool"
    );

    expect(coverage.status).toBe("covered");
    expect(coverage.summary.missing).toBe(0);
    expect(coverage.relatedWarnings).toEqual([]);
  });

  it("detects missing Slack provider reachability in a non-demo task", () => {
    const graph: SnitchGraph = {
      id: "slack-fixture",
      title: "Slack fixture",
      nodes: [
        node("tool:post_slack_message", "tool", "Post Slack message"),
        node("schema:post_slack_message_input", "schema", "Slack message input")
      ],
      edges: [
        edge(
          "edge:post-slack-validates-input",
          "tool:post_slack_message",
          "schema:post_slack_message_input",
          "validates"
        )
      ]
    };
    const coverage = verifyIntentCoverage(graph, [], "Add a Slack notification tool");

    expect(coverage.status).toBe("partial");
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "slack_notification:tool",
        status: "met"
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "slack_notification:external",
        status: "missing"
      })
    );
  });

  it("does not count unrelated companion nodes as task coverage", () => {
    const graph: SnitchGraph = {
      id: "unrelated-companions",
      title: "Unrelated companions",
      nodes: [
        node("tool:create_issue", "tool", "Create issue tool"),
        node("schema:create_issue_input", "schema", "Create issue input"),
        node("external:api.github.com", "external", "GitHub Issues API"),
        node("env:GITHUB_TOKEN", "env", "GITHUB_TOKEN"),
        node("service:tool_audit_log", "service", "Tool audit log"),
        node("service:secret_redactor", "service", "Secret redactor"),
        node("contract:issue_tool_permission_scope", "contract", "Issue permission scope"),
        node("test:issue_tool_smoke", "test", "Issue tool smoke test")
      ],
      edges: [
        edge("edge:create-issue-validates-input", "tool:create_issue", "schema:create_issue_input", "validates"),
        edge("edge:create-issue-calls-provider", "tool:create_issue", "external:api.github.com", "calls"),
        edge("edge:create-issue-uses-provider-key", "tool:create_issue", "env:GITHUB_TOKEN", "uses_secret"),
        edge("edge:smoke-test-covers-create-issue", "test:issue_tool_smoke", "tool:create_issue", "covers")
      ]
    };
    const coverage = verifyIntentCoverage(graph, [], "Add an external issue creation tool");

    expect(coverage.status).toBe("partial");
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:audit",
        status: "missing"
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:redaction",
        status: "missing"
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:permission",
        status: "missing"
      })
    );
    expect(coverage.requirements).toContainEqual(
      expect.objectContaining({
        id: "issue_creation:unauthorized_test",
        status: "missing"
      })
    );
  });

  it("does not invent coverage for unclassified task text", () => {
    const coverage = verifyIntentCoverage(
      {
        id: "empty",
        title: "Empty graph",
        nodes: [],
        edges: []
      },
      [],
      "Refactor the component styling"
    );

    expect(coverage.status).toBe("unclassified");
    expect(coverage.requirements).toEqual([]);
  });
});

function node(id: string, kind: SnitchGraph["nodes"][number]["kind"], label: string): SnitchGraph["nodes"][number] {
  return {
    id,
    kind,
    label,
    hash: id
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: SnitchGraph["edges"][number]["kind"]
): SnitchGraph["edges"][number] {
  return {
    id,
    from,
    to,
    kind,
    hash: id
  };
}
