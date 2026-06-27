import { describe, expect, it } from "vitest";
import { buildSnitchFindings } from "./findings";
import type { SnitchGraph, SnitchWarning } from "./types";

describe("buildSnitchFindings", () => {
  it("anchors warning findings to the nearest code-owned graph node", () => {
    const findings = buildSnitchFindings(graphWithWarning, [redactionWarning]);
    const redactionFinding = findings.find(
      (finding) => finding.warningId === "warning:secret_redaction_missing:create_issue"
    );

    expect(findings).toHaveLength(1);
    expect(redactionFinding).toMatchObject({
      id: "finding:secret_redaction_missing:create_issue",
      severity: "high",
      anchor: {
        nodeId: "tool:create_issue",
        label: "Create issue tool",
        file: "src/tools/create-issue.ts",
        line: 9
      },
      repairCommand:
        "pnpm snitch repair-prompt --warning warning:secret_redaction_missing:create_issue"
    });
    expect(redactionFinding?.relatedNodeIds).toContain("env:ISSUE_PROVIDER_API_KEY");
  });
});

const redactionWarning: SnitchWarning = {
  id: "warning:secret_redaction_missing:create_issue",
  kind: "warning",
  severity: "high",
  title: "No secret redaction around provider data",
  message: "The tool uses a provider credential but no redaction service is connected.",
  evidence: [
    "tool:create_issue -> env:ISSUE_PROVIDER_API_KEY",
    "No service:secret_redactor node is called by tool:create_issue."
  ]
};

const graphWithWarning: SnitchGraph = {
  id: "test",
  title: "Test",
  nodes: [
    {
      id: "tool:create_issue",
      kind: "tool",
      label: "Create issue tool",
      file: "src/tools/create-issue.ts",
      line: 9,
      hash: "tool"
    },
    {
      id: "env:ISSUE_PROVIDER_API_KEY",
      kind: "env",
      label: "ISSUE_PROVIDER_API_KEY",
      file: "src/tools/create-issue.ts",
      line: 18,
      hash: "env"
    },
    {
      id: "warning:secret_redaction_missing:create_issue",
      kind: "warning",
      label: "No secret redaction around provider data",
      hash: "warning"
    }
  ],
  edges: [
    {
      id: "edge:tool-uses-env",
      from: "tool:create_issue",
      to: "env:ISSUE_PROVIDER_API_KEY",
      kind: "uses_secret",
      hash: "uses"
    },
    {
      id: "edge:warning:secret_redaction_missing:create_issue:missing",
      from: "tool:create_issue",
      to: "warning:secret_redaction_missing:create_issue",
      kind: "missing",
      hash: "missing"
    }
  ]
};
