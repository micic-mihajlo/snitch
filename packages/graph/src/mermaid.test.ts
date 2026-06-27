import { describe, expect, it } from "vitest";
import { getDemoReplay, getReviewSnapshot, graphToMermaid } from "./index";

describe("graphToMermaid", () => {
  it("generates deterministic Mermaid from graph IR", () => {
    const snapshot = getReviewSnapshot(getDemoReplay());
    const first = graphToMermaid(snapshot.graph);
    const second = graphToMermaid(snapshot.graph);

    expect(first).toBe(second);
    expect(first).toContain("flowchart LR");
    expect(first).toContain("tool_create_issue[\"Create issue tool\"]");
    expect(first).toContain("external_issue_provider[\"Issue provider API\"]");
    expect(first).toContain("tool_create_issue -->|calls| external_issue_provider");
  });
});
