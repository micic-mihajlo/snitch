import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractTypeScriptGraph } from "./index";

const demoRoot = resolve(import.meta.dirname, "../../../apps/demo-app");

describe("extractTypeScriptGraph", () => {
  it("derives the issue-tool system graph from real TypeScript files", () => {
    const result = extractTypeScriptGraph({ cwd: demoRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "agent:router",
        "service:tool_registry",
        "tool:create_issue",
        "schema:create_issue_input",
        "external:api.github.com",
        "env:ISSUE_PROVIDER_API_KEY",
        "warning:tool_audit_log_missing:create_issue",
        "warning:secret_redaction_missing:create_issue",
        "warning:permission_scope_missing:create_issue",
        "warning:unauthorized_test_missing:create_issue"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:registry-registers-create-issue",
        "edge:create-issue-validates-input",
        "edge:create-issue-calls-provider",
        "edge:create-issue-uses-provider-key"
      ])
    );
    expect(result.snapshot.warnings).toHaveLength(4);
    expect(result.snapshot.graph.nodes.find((node) => node.id === "tool:create_issue")?.file).toBe(
      "src/tools/create-issue.ts"
    );
  });
});
