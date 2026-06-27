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

  it("discovers code in a root-level layout with no src/ directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-rootlevel-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "app/api/charge"), { recursive: true });
    await writeFile(
      join(tempRoot, "app/api/charge/route.ts"),
      [
        "export async function POST(request: Request) {",
        "  const body = await request.json();",
        "  await fetch(\"https://api.stripe.com/v1/charges\", {",
        "    method: \"POST\",",
        "    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },",
        "    body: JSON.stringify(body)",
        "  });",
        "  return Response.json({ ok: true });",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);

    expect(result.sourceFileCount).toBeGreaterThan(0);
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "endpoint:POST:/api/charge",
        "external:api.stripe.com",
        "env:STRIPE_SECRET_KEY"
      ])
    );
  });

  it("extracts common server route registrations beyond file-based route handlers", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-server-route-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/server.ts"),
      [
        "const app = createServer();",
        "const router = createRouter();",
        "const fastify = createFastify();",
        "const hono = createHono();",
        "",
        "app.post(\"/api/messages\", async (_req, res) => {",
        "  await fetch(\"https://api.openai.com/v1/responses\", {",
        "    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }",
        "  });",
        "  return res.json({ ok: true });",
        "});",
        "",
        "router.delete(\"/api/messages/:id\", async () => {",
        "  await fetch(\"https://api.github.com/repos/acme/app/issues\");",
        "});",
        "",
        "fastify.route({",
        "  method: \"PATCH\",",
        "  url: \"/api/jobs/:id\",",
        "  handler: async () => {",
        "    await fetch(\"https://api.linear.app/graphql\");",
        "  }",
        "});",
        "",
        "hono.get(\"/api/ping\", (c) => c.json({ ok: true }));",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/admin.controller.ts"),
      [
        "function Controller(_path?: string) { return () => undefined; }",
        "function Get(_path?: string) { return () => undefined; }",
        "",
        "@Controller(\"admin\")",
        "class AdminController {",
        "  @Get(\"health\")",
        "  health() {",
        "    return fetch(\"https://status.example.com/check\");",
        "  }",
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
        "endpoint:POST:/api/messages",
        "endpoint:DELETE:/api/messages/:id",
        "endpoint:PATCH:/api/jobs/:id",
        "endpoint:GET:/api/ping",
        "endpoint:GET:/admin/health"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:endpoint_post_api_messages-calls-external_api_openai_com",
        "edge:endpoint_post_api_messages-uses-env_openai_api_key",
        "edge:endpoint_delete_api_messages_id-calls-external_api_github_com",
        "edge:endpoint_patch_api_jobs_id-calls-external_api_linear_app",
        "edge:endpoint_get_admin_health-calls-external_status_example_com"
      ])
    );
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

  it("extracts agent-native CLI commands and MCP tool definitions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-agent-tooling-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/cli.ts"),
      [
        "export async function runCli(args: string[]) {",
        "  const command = args[0] ?? \"help\";",
        "  if (command === \"briefing\") {",
        "    return readSnitchBriefing();",
        "  }",
        "  if (\"verify-intent\" === command) {",
        "    return readSnitchIntent();",
        "  }",
        "}",
        "",
        "function createMcpTools() {",
        "  return [",
        "    {",
        "      name: \"snitch_briefing\",",
        "      title: \"Snitch Agent Briefing\",",
        "      description: \"Return a compact coding-agent briefing.\"",
        "    },",
        "    {",
        "      name: \"snitch_verify_intent\",",
        "      title: \"Snitch Intent Coverage\",",
        "      description: \"Verify task coverage.\"",
        "    }",
        "  ];",
        "}",
        "",
        "export function parseShellCommand(command: string) {",
        "  if (command === \"deploy\") {",
        "    return \"not a Snitch CLI command\";",
        "  }",
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
        "service:cli_snitch_cli",
        "service:cli_snitch_mcp_server",
        "tool:cli_cli_briefing",
        "tool:cli_cli_verify_intent",
        "tool:cli_snitch_briefing",
        "tool:cli_snitch_verify_intent"
      ])
    );
    expect(nodeIds).not.toContain("tool:cli_cli_deploy");
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:snitch-cli-registers-tool_cli_cli_briefing",
        "edge:snitch-cli-registers-tool_cli_cli_verify_intent",
        "edge:snitch-mcp-registers-tool_cli_snitch_briefing",
        "edge:snitch-mcp-registers-tool_cli_snitch_verify_intent",
        "edge:tool_cli_snitch_briefing-calls-tool_cli_cli_briefing",
        "edge:tool_cli_snitch_verify_intent-calls-tool_cli_cli_verify_intent"
      ])
    );
  });

  it("detects external calls through axios and provider SDKs, not just fetch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-http-clients-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/charge.ts"),
      [
        "import axios from \"axios\";",
        "export const chargeTool = {",
        "  name: \"charge_card\",",
        "  async execute(input: unknown) {",
        "    return axios.post(\"https://api.stripe.com/v1/charges\", input, {",
        "      headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }",
        "    });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/refund.ts"),
      [
        "import Stripe from \"stripe\";",
        "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? \"\");",
        "export const refundTool = {",
        "  name: \"refund\",",
        "  async execute(input: unknown) {",
        "    return stripe.refunds.create(input as never);",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const nodeIds = result.snapshot.graph.nodes.map((node) => node.id);
    const warningIds = result.snapshot.warnings.map((warning) => warning.id);

    expect(nodeIds).toEqual(expect.arrayContaining(["external:api.stripe.com", "external:stripe"]));
    // The axios + Stripe-SDK calls are external capabilities, so the warning engine must fire
    // even though neither uses fetch.
    expect(warningIds).toEqual(
      expect.arrayContaining([
        "warning:tool_audit_log_missing:charge_card",
        "warning:secret_redaction_missing:charge_card",
        "warning:tool_audit_log_missing:refund"
      ])
    );
  });

  it("suppresses companion warnings when role-named safeguards exist", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-companion-roles-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/safeguards.ts"),
      [
        "export const auditLogger = { write(entry: unknown) { return entry; } };",
        "export const sanitizePayload = (value: unknown) => value;",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/notify.ts"),
      [
        "import { auditLogger } from \"./safeguards\";",
        "import { sanitizePayload } from \"./safeguards\";",
        "export const notifyTool = {",
        "  name: \"notify\",",
        "  async execute(input: unknown) {",
        "    auditLogger.write({ tool: \"notify\" });",
        "    return fetch(\"https://hooks.slack.com/services/x\", { body: JSON.stringify(sanitizePayload(input)) });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const warningIds = result.snapshot.warnings.map((warning) => warning.id);

    // A real audit logger + redactor are present, so those companions must NOT be flagged.
    expect(warningIds).not.toContain("warning:tool_audit_log_missing:notify");
    expect(warningIds).not.toContain("warning:secret_redaction_missing:notify");
    // Permission scope and an unauthorized-call test are still genuinely missing.
    expect(warningIds).toEqual(
      expect.arrayContaining([
        "warning:permission_scope_missing:notify",
        "warning:unauthorized_test_missing:notify"
      ])
    );
  });

  it("does not let unrelated safeguards suppress warnings for every external tool", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-companion-scope-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/safeguards.ts"),
      [
        "export const auditLogger = { write(entry: unknown) { return entry; } };",
        "export const sanitizePayload = (value: unknown) => value;",
        "export const notifyPermissionScope = { capability: \"notify\" };",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/notify.ts"),
      [
        "import { auditLogger, sanitizePayload } from \"./safeguards\";",
        "export const notifyTool = {",
        "  name: \"notify\",",
        "  async execute(input: unknown) {",
        "    auditLogger.write({ tool: \"notify\" });",
        "    return fetch(\"https://hooks.slack.com/services/x\", { body: JSON.stringify(sanitizePayload(input)) });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "src/charge.ts"),
      [
        "export const chargeTool = {",
        "  name: \"charge_card\",",
        "  async execute(input: unknown) {",
        "    return fetch(\"https://api.stripe.com/v1/charges\", { body: JSON.stringify(input) });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const warningIds = result.snapshot.warnings.map((warning) => warning.id);

    expect(warningIds).not.toContain("warning:tool_audit_log_missing:notify");
    expect(warningIds).not.toContain("warning:secret_redaction_missing:notify");
    expect(warningIds).not.toContain("warning:permission_scope_missing:notify");
    expect(warningIds).toEqual(
      expect.arrayContaining([
        "warning:tool_audit_log_missing:charge_card",
        "warning:secret_redaction_missing:charge_card",
        "warning:permission_scope_missing:charge_card"
      ])
    );
  });

  it("connects generic registries, permission contracts, and unauthorized tests for non-demo tools", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-generic-companion-coverage-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await mkdir(join(tempRoot, "tests"), { recursive: true });
    await writeFile(
      join(tempRoot, "src/notify.ts"),
      [
        "export const toolRegistry = [];",
        "export const auditLogger = { write(entry: unknown) { return entry; } };",
        "export const sanitizePayload = (value: unknown) => value;",
        "export const notifyPermissionScope = { capability: \"notify\" };",
        "export const notifyTool = {",
        "  name: \"notify\",",
        "  async execute(input: unknown) {",
        "    auditLogger.write({ tool: \"notify\" });",
        "    return fetch(\"https://hooks.slack.com/services/x\", { body: JSON.stringify(sanitizePayload(input)) });",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "tests/notify.test.ts"),
      [
        "import { notifyTool } from \"../src/notify\";",
        "test(\"notify rejects unauthorized callers\", async () => {",
        "  await expect(notifyTool.execute({ unauthorized: true })).rejects.toThrow(/unauthorized|permission/i);",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const warningIds = result.snapshot.warnings.map((warning) => warning.id);
    const edgeIds = result.snapshot.graph.edges.map((edge) => edge.id);

    expect(warningIds).not.toContain("warning:tool_audit_log_missing:notify");
    expect(warningIds).not.toContain("warning:secret_redaction_missing:notify");
    expect(warningIds).not.toContain("warning:permission_scope_missing:notify");
    expect(warningIds).not.toContain("warning:unauthorized_test_missing:notify");
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:service_tool_registry-registers-tool_notify",
        "edge:tool_notify-writes-service_audit_logger",
        "edge:tool_notify-calls-service_sanitize_payload",
        "edge:tool_notify-satisfies-contract_notify_permission_scope",
        "edge:test_notify_test_unauthorized-covers-tool_notify"
      ])
    );
  });

  it("warns on route handlers that call an external system, not only agent tools", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-route-warning-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "app/api/charge"), { recursive: true });
    await writeFile(
      join(tempRoot, "app/api/charge/route.ts"),
      [
        "export async function POST(request: Request) {",
        "  const body = await request.json();",
        "  await fetch(\"https://api.stripe.com/v1/charges\", {",
        "    method: \"POST\",",
        "    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },",
        "    body: JSON.stringify(body)",
        "  });",
        "  return Response.json({ ok: true });",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = extractTypeScriptGraph({ cwd: tempRoot });
    const warningIds = result.snapshot.warnings.map((warning) => warning.id);

    expect(warningIds).toEqual(
      expect.arrayContaining([
        "warning:tool_audit_log_missing:post_api_charge",
        "warning:secret_redaction_missing:post_api_charge"
      ])
    );
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

  it("extracts Knex, TypeORM, and Mongoose reads and writes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "snitch-orm-extractor-"));
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "app/api/users"), { recursive: true });
    await writeFile(
      join(tempRoot, "app/api/users/route.ts"),
      [
        "export async function GET() {",
        "  await knex(\"users\").select(\"*\");",
        "  await userRepository.find();",
        "  await UserModel.findById(\"user_123\");",
        "  return Response.json({ ok: true });",
        "}",
        "",
        "export async function POST(request: Request) {",
        "  const payload = await request.json();",
        "  await db(\"audit_logs\").insert(payload);",
        "  await dataSource.getRepository(Order).save(payload);",
        "  await Invoice.deleteMany({ stale: true });",
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
        "database:knex_users",
        "database:typeorm_user",
        "database:mongoose_user",
        "database:knex_audit_logs",
        "database:typeorm_order",
        "database:mongoose_invoice"
      ])
    );
    expect(edgeIds).toEqual(
      expect.arrayContaining([
        "edge:endpoint_get_api_users-reads-database_knex_users",
        "edge:endpoint_get_api_users-reads-database_typeorm_user",
        "edge:endpoint_get_api_users-reads-database_mongoose_user",
        "edge:endpoint_post_api_users-writes-database_knex_audit_logs",
        "edge:endpoint_post_api_users-writes-database_typeorm_order",
        "edge:endpoint_post_api_users-writes-database_mongoose_invoice"
      ])
    );
  });
});
