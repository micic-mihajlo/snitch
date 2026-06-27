import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnitchArtifacts } from "../packages/graph/src/index";
import { extractTypeScriptGraph } from "../packages/extractor-ts/src/index";

type ResetOptions = {
  target: string;
  artifactsDir: string;
  now?: Date;
};

type ParsedArgs = {
  flags: Map<string, string | true>;
};

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

export async function resetDemoApp(options: ResetOptions): Promise<{
  nodeCount: number;
  edgeCount: number;
  warningCount: number;
}> {
  const target = resolve(options.target);
  const artifactsDir = resolve(options.artifactsDir);
  const now = options.now ?? new Date();

  await Promise.all(
    repairOnlyFiles.map((path) => rm(join(target, path), { force: true }))
  );
  await Promise.all(
    Object.entries(unsafeFiles).map(async ([path, contents]) => {
      const outputPath = join(target, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${contents.trim()}\n`, "utf8");
    })
  );

  const extracted = extractTypeScriptGraph({
    cwd: target,
    title: `Unsafe graph for ${basename(target) || "demo-app"}`,
    generatedAt: now.toISOString()
  });
  const artifacts = buildSnitchArtifacts({
    replay: [extracted.snapshot],
    reviewSnapshot: extracted.snapshot,
    createdAt: now.toISOString(),
    runId: "snitch-unsafe-demo",
    task,
    source: "snitch-demo-reset"
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

const repairOnlyFiles = [
  "src/lib/tool-audit-log.ts",
  "src/lib/secret-redactor.ts"
];

const unsafeFiles: Record<string, string> = {
  "src/lib/session-permissions.ts": `
export type SessionPermission = {
  sessionId: string;
  capability: string;
};

export function hasSessionPermission(_permission: SessionPermission): boolean {
  return false;
}
`,
  "src/tools/create-issue.ts": `
import { z } from "zod";

export const createIssueInputSchema = z.object({
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
    const response = await fetch("https://api.github.com/repos/acme/app/issues", {
      method: "POST",
      headers: {
        authorization: \`Bearer \${process.env.ISSUE_PROVIDER_API_KEY}\`,
        "content-type": "application/json"
      },
      body: JSON.stringify(parsed)
    });

    return response.json();
  }
};
`,
  "tests/create-issue.test.ts": `
import { createIssueTool } from "../src/tools/create-issue";

test("create_issue exposes provider metadata", () => {
  expect(createIssueTool.name).toBe("create_issue");
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
  const result = await resetDemoApp({
    target: String(parsed.flags.get("target") ?? "apps/demo-app"),
    artifactsDir: String(parsed.flags.get("artifacts") ?? ".snitch")
  });

  console.log(
    [
      "Reset Snitch demo app to the unsafe agent-output state.",
      `- Nodes: ${result.nodeCount}`,
      `- Edges: ${result.edgeCount}`,
      `- Warnings: ${result.warningCount}`,
      "- Updated demo files and Snitch artifacts"
    ].join("\n")
  );
}
