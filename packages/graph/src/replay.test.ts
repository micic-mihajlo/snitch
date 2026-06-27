import { describe, expect, it } from "vitest";
import { getDemoReplay, getReviewSnapshot } from "./index";

describe("demo replay", () => {
  it("contains a staged issue-tool capability graph with missing companion warnings", () => {
    const replay = getDemoReplay();
    const reviewSnapshot = getReviewSnapshot(replay);

    expect(replay.length).toBeGreaterThanOrEqual(4);
    expect(reviewSnapshot.graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "agent:router",
        "service:tool_registry",
        "tool:create_issue",
        "schema:create_issue_input",
        "external:issue_provider",
        "env:ISSUE_PROVIDER_API_KEY"
      ])
    );
    expect(reviewSnapshot.graph.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(["registers", "validates", "calls", "uses_secret"])
    );
    expect(reviewSnapshot.warnings.map((warning) => warning.id)).toEqual([
      "warning:tool_audit_log_missing:create_issue",
      "warning:secret_redaction_missing:create_issue",
      "warning:permission_scope_missing:create_issue",
      "warning:unauthorized_test_missing:create_issue"
    ]);
    expect(reviewSnapshot.warnings.every((warning) => warning.repairPrompt)).toBe(true);
  });
});
