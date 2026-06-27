import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDemoRepair } from "../../../scripts/apply-demo-repair";
import { resetDemoApp } from "../../../scripts/reset-demo-app";
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

  it("resets the repaired demo app back to the unsafe warning state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-reset-demo-"));
    const demoCopy = join(tempRoot, "demo-app");
    const artifactsDir = join(tempRoot, ".snitch");
    tempDirs.push(tempRoot);
    await cp(demoRoot, demoCopy, { recursive: true });

    await applyDemoRepair({
      target: demoCopy,
      artifactsDir,
      now: new Date("2026-06-27T12:00:00.000Z")
    });
    await resetDemoApp({
      target: demoCopy,
      artifactsDir,
      now: new Date("2026-06-27T12:01:00.000Z")
    });
    const result = extractTypeScriptGraph({ cwd: demoCopy });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);

    expect(result.snapshot.warnings).toHaveLength(4);
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "warning:tool_audit_log_missing:create_issue",
        "warning:secret_redaction_missing:create_issue",
        "warning:permission_scope_missing:create_issue",
        "warning:unauthorized_test_missing:create_issue"
      ])
    );
    expect(nodeIds).not.toContain("service:tool_audit_log");
    expect(nodeIds).not.toContain("service:secret_redactor");
    await expect(readFile(join(artifactsDir, "pr-comment.md"), "utf8")).resolves.toContain(
      "Active warnings: 4"
    );
  });

  it("extracts generic route handlers, tool objects, schemas, external calls, and env vars", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-generic-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src/app/api/messages"), { recursive: true });
    await mkdir(join(tempRoot, "src/tools"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/app/api/messages/route.ts"),
      [
        "export async function GET() {",
        "  await fetch(\"https://api.openai.com/v1/models\");",
        "  return Response.json({ ok: true });",
        "}",
        "",
        "export async function POST() {",
        "  await fetch(\"https://api.openai.com/v1/responses\", {",
        "    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }",
        "  });",
        "  return Response.json({ ok: true });",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/tools/slack.ts"),
      [
        "import { z } from \"zod\";",
        "export const postSlackMessageInputSchema = z.object({",
        "  channel: z.string(),",
        "  text: z.string()",
        "});",
        "export const slackTool = {",
        "  name: \"post_slack_message\",",
        "  inputSchema: postSlackMessageInputSchema,",
        "  async execute(input: unknown) {",
        "    await fetch(\"https://hooks.slack.com/services/T000/B000/XXX\", {",
        "      method: \"POST\",",
        "      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },",
        "      body: JSON.stringify(input)",
        "    });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "endpoint:GET:/api/messages",
        "endpoint:POST:/api/messages",
        "tool:post_slack_message",
        "schema:post_slack_message_input",
        "external:api.openai.com",
        "external:hooks.slack.com",
        "env:OPENAI_API_KEY",
        "env:SLACK_BOT_TOKEN"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:endpoint_get_api_messages-calls-external_api_openai_com",
        "edge:endpoint_post_api_messages-calls-external_api_openai_com",
        "edge:endpoint_post_api_messages-uses-env_openai_api_key",
        "edge:tool_post_slack_message-validates-schema_post_slack_message_input",
        "edge:tool_post_slack_message-calls-external_hooks_slack_com",
        "edge:tool_post_slack_message-uses-env_slack_bot_token"
      ])
    );
    expect(edgeIds).not.toContain("edge:endpoint_get_api_messages-uses-env_openai_api_key");
  });

  it("extracts MCP-style registered tools with schemas and side effects", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-mcp-tool-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src/mcp"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/mcp/server.ts"),
      [
        "import { z } from \"zod\";",
        "import { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";",
        "",
        "const server = new McpServer({ name: \"builder-tools\", version: \"1.0.0\" });",
        "const createIssueInputSchema = z.object({",
        "  title: z.string(),",
        "  body: z.string().optional()",
        "});",
        "",
        "server.registerTool(",
        "  \"create_issue\",",
        "  { title: \"Create issue\", inputSchema: createIssueInputSchema },",
        "  async (input) => {",
        "    await fetch(\"https://api.github.com/repos/acme/widgets/issues\", {",
        "      method: \"POST\",",
        "      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },",
        "      body: JSON.stringify(input)",
        "    });",
        "  }",
        ");",
        "",
        "server.tool(\"send_status\", { channel: z.string() }, async ({ channel }) => {",
        "  await fetch(\"https://hooks.slack.com/services/T000/B000/XXX\", {",
        "    method: \"POST\",",
        "    body: JSON.stringify({ channel })",
        "  });",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "tool:create_issue",
        "schema:create_issue_input",
        "tool:send_status",
        "schema:send_status_input",
        "external:api.github.com",
        "external:hooks.slack.com",
        "env:GITHUB_TOKEN"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:create-issue-validates-input",
        "edge:create-issue-calls-provider",
        "edge:tool_create_issue-uses-env_github_token",
        "edge:tool_send_status-validates-schema_send_status_input",
        "edge:tool_send_status-calls-external_hooks_slack_com"
      ])
    );
    expect(result.snapshot.warnings.map((warning) => warning.id)).toEqual(
      expect.arrayContaining([
        "warning:tool_audit_log_missing:create_issue",
        "warning:secret_redaction_missing:create_issue",
        "warning:tool_audit_log_missing:send_status",
        "warning:secret_redaction_missing:send_status",
        "warning:permission_scope_missing:send_status",
        "warning:unauthorized_test_missing:send_status"
      ])
    );
    const sendStatusAuditWarning = result.snapshot.warnings.find(
      (warning) => warning.id === "warning:tool_audit_log_missing:send_status"
    );

    expect(sendStatusAuditWarning?.repairPrompt).toContain("send_status");
  });

  it("extracts database reads and writes from common TypeScript data clients", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-database-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src/app/api/users"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/app/api/users/route.ts"),
      [
        "export async function GET() {",
        "  await db.select().from(messages);",
        "  return Response.json({ ok: true });",
        "}",
        "",
        "export async function POST(request: Request) {",
        "  const payload = await request.json();",
        "  await prisma.user.create({ data: payload });",
        "  await supabase.from(\"audit_logs\").insert(payload);",
        "  return Response.json({ ok: true });",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "endpoint:GET:/api/users",
        "endpoint:POST:/api/users",
        "database:drizzle_messages",
        "database:prisma_user",
        "database:supabase_audit_logs"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:endpoint_get_api_users-reads-database_drizzle_messages",
        "edge:endpoint_post_api_users-writes-database_prisma_user",
        "edge:endpoint_post_api_users-writes-database_supabase_audit_logs"
      ])
    );
    expect(edgeIds).not.toContain("edge:endpoint_get_api_users-writes-database_prisma_user");
    expect(edgeIds).not.toContain("edge:endpoint_get_api_users-writes-database_supabase_audit_logs");
  });
});
