import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDemoRepair } from "../../../scripts/apply-demo-repair";
import { extractTypeScriptGraph } from "./index";

const demoRoot = resolve(import.meta.dirname, "../../../apps/demo-app");
const tempDirs: string[] = [];

describe("extractTypeScriptGraph", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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

  it("clears missing companion warnings after the demo repair pass", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-repaired-demo-"));
    const repairedRoot = join(tempRoot, "demo-app");
    const artifactsDir = join(tempRoot, ".snitch");
    tempDirs.push(tempRoot);
    await cp(demoRoot, repairedRoot, { recursive: true });

    const repairResult = await applyDemoRepair({
      target: repairedRoot,
      artifactsDir,
      now: new Date("2026-06-27T12:00:00.000Z")
    });
    const result = extractTypeScriptGraph({ cwd: repairedRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(repairResult.warningCount).toBe(0);
    expect(result.snapshot.warnings).toHaveLength(0);
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "service:tool_audit_log",
        "service:secret_redactor",
        "contract:issue_tool_permission_scope",
        "test:issue_tool_rejects_unauthorized"
      ])
    );
    expect(nodeIds.some((id) => id.startsWith("warning:"))).toBe(false);
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:create-issue-writes-audit",
        "edge:create-issue-calls-redactor",
        "edge:create-issue-satisfies-permission",
        "edge:test-covers-create-issue"
      ])
    );
    await expect(readFile(join(artifactsDir, "pr-comment.md"), "utf8")).resolves.toContain(
      "No active Snitch warnings."
    );
  });
});
