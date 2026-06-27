import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnitchArtifacts } from "../packages/graph/src/index";
import { extractTypeScriptGraph } from "../packages/extractor-ts/src/index";

type RepairOptions = {
  target: string;
  artifactsDir: string;
  now?: Date;
};

type ParsedArgs = {
  flags: Map<string, string | true>;
};

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export async function applyDemoRepair(options: RepairOptions): Promise<{
  nodeCount: number;
  edgeCount: number;
  warningCount: number;
}> {
  const target = resolve(options.target);
  const artifactsDir = resolve(options.artifactsDir);
  const now = options.now ?? new Date();

  await Promise.all(
    Object.entries(repairFiles).map(async ([path, contents]) => {
      const outputPath = join(target, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${contents.trim()}\n`, "utf8");
    })
  );

  const extracted = extractTypeScriptGraph({
    cwd: target,
    title: `Repaired graph for ${basename(target) || "demo-app"}`,
    generatedAt: now.toISOString()
  });
  const artifacts = buildSnitchArtifacts({
    replay: [extracted.snapshot],
    reviewSnapshot: extracted.snapshot,
    createdAt: now.toISOString(),
    runId: "snitch-repaired-demo",
    task,
    source: "snitch-demo-repair"
  });

  await mkdir(artifactsDir, { recursive: true });
  await Promise.all(
    Object.entries(artifacts).map(([filename, contents]) =>
      writeFile(join(artifactsDir, filename), `${contents}\n`, "utf8")
    )
  );

  return {
    nodeCount: extracted.snapshot.graph.nodes.length,
    edgeCount: extracted.snapshot.graph.edges.length,
    warningCount: extracted.snapshot.warnings.length
  };
}

const repairFiles: Record<string, string> = {
  "src/lib/tool-audit-log.ts": `
export type ToolAuditRecord = {
  sessionId: string;
  toolName: string;
  provider: string;
  status: "ok" | "error";
  payloadSummary: unknown;
};

export const toolAuditLog = {
  async write(record: ToolAuditRecord) {
    return {
      ...record,
      writtenAt: new Date().toISOString()
    };
  }
};
`,
  "src/lib/secret-redactor.ts": `
export const secretRedactor = {
  redact(value: unknown) {
    return JSON.parse(
      JSON.stringify(value, (_key, entry) =>
        typeof entry === "string" && entry.length > 16 ? "[redacted]" : entry
      )
    );
  },
  redactError(error: unknown) {
    return error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{18,}/g, "[redacted]") : "provider error";
  }
};
`,
  "src/lib/session-permissions.ts": `
export type SessionPermission = {
  sessionId: string;
  capability: string;
};

export const issueToolPermissionScope = {
  capability: "create_issue",
  description: "External issue creation requires scoped per-session approval."
};

export function hasSessionPermission(permission: SessionPermission): boolean {
  return permission.capability === issueToolPermissionScope.capability && permission.sessionId.length > 0;
}
`,
  "src/tools/create-issue.ts": `
import { z } from "zod";
import { secretRedactor } from "../lib/secret-redactor";
import { hasSessionPermission, issueToolPermissionScope } from "../lib/session-permissions";
import { toolAuditLog } from "../lib/tool-audit-log";

export const createIssueInputSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).default([])
});

export const createIssueTool = {
  name: "create_issue",
  description: "Create an issue in the provider from an assistant request.",
  inputSchema: createIssueInputSchema,
  async execute(input: unknown) {
    const parsed = createIssueInputSchema.parse(input);

    if (
      !hasSessionPermission({
        sessionId: parsed.sessionId,
        capability: issueToolPermissionScope.capability
      })
    ) {
      throw new Error("unauthorized createIssue call");
    }

    try {
      const response = await fetch("https://api.github.com/repos/acme/app/issues", {
        method: "POST",
        headers: {
          authorization: \`Bearer \${process.env.ISSUE_PROVIDER_API_KEY}\`,
          "content-type": "application/json"
        },
        body: JSON.stringify(secretRedactor.redact(parsed))
      });
      const result = await response.json();

      await toolAuditLog.write({
        sessionId: parsed.sessionId,
        toolName: "create_issue",
        provider: "api.github.com",
        status: "ok",
        payloadSummary: secretRedactor.redact({ title: parsed.title, labels: parsed.labels })
      });

      return result;
    } catch (error) {
      await toolAuditLog.write({
        sessionId: parsed.sessionId,
        toolName: "create_issue",
        provider: "api.github.com",
        status: "error",
        payloadSummary: secretRedactor.redactError(error)
      });
      throw error;
    }
  }
};
`,
  "tests/create-issue.test.ts": `
import { createIssueTool } from "../src/tools/create-issue";

test("create_issue exposes provider metadata", () => {
  expect(createIssueTool.name).toBe("create_issue");
});

test("createIssue rejects unauthorized calls", async () => {
  await expect(
    createIssueTool.execute({
      sessionId: "",
      title: "Ship Snitch repair pass"
    })
  ).rejects.toThrow(/unauthorized/i);
});
`
};

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg?.startsWith("--")) {
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];

    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { flags };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await applyDemoRepair({
    target: String(parsed.flags.get("target") ?? "apps/demo-app"),
    artifactsDir: String(parsed.flags.get("artifacts") ?? ".snitch")
  });

  console.log(
    [
      "Applied Snitch demo repair pass.",
      `- Nodes: ${result.nodeCount}`,
      `- Edges: ${result.edgeCount}`,
      `- Warnings: ${result.warningCount}`,
      "- Updated demo files and Snitch artifacts"
    ].join("\n")
  );
}
