import { relative } from "node:path";
import {
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  type CallExpression,
  type Node as TsMorphNode,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration
} from "ts-morph";
import {
  createMissingCompanionWarnings,
  hashEvidence,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type ReplaySnapshot,
  type SnitchGraph,
  type SnitchWarning
} from "@snitch/graph";

export type ExtractTypeScriptGraphOptions = {
  cwd: string;
  title?: string;
  generatedAt?: string;
};

export type ExtractTypeScriptGraphResult = {
  snapshot: ReplaySnapshot;
};

type MutableGraph = {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  warnings: SnitchWarning[];
};

export function extractTypeScriptGraph(options: ExtractTypeScriptGraphOptions): ExtractTypeScriptGraphResult {
  const project = new Project({
    manipulationSettings: {
      quoteKind: QuoteKind.Double
    },
    compilerOptions: {
      allowJs: false,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      moduleResolution: 100,
      skipLibCheck: true,
      strict: false
    },
    skipFileDependencyResolution: true
  });

  project.addSourceFilesAtPaths([
    `${options.cwd}/src/**/*.{ts,tsx}`,
    `${options.cwd}/tests/**/*.{ts,tsx}`
  ]);

  const graph: MutableGraph = {
    nodes: new Map(),
    edges: new Map(),
    warnings: []
  };

  for (const sourceFile of project.getSourceFiles()) {
    extractAssistantSurface(options.cwd, sourceFile, graph);
    extractToolSurface(options.cwd, sourceFile, graph);
    extractSchemaSurface(options.cwd, sourceFile, graph);
    extractProviderSurface(options.cwd, sourceFile, graph);
    extractTestSurface(options.cwd, sourceFile, graph);
  }

  connectKnownIssueTool(graph);
  attachMissingCompanionWarnings(graph);

  const snitchGraph: SnitchGraph = {
    id: "extractor-ts",
    title: options.title ?? "TypeScript extractor snapshot",
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
    meta: {
      source: "ts-morph"
    }
  };

  if (options.generatedAt) {
    snitchGraph.generatedAt = options.generatedAt;
  }

  const snapshot: ReplaySnapshot = {
    id: "extractor-ts",
    title: options.title ?? "TypeScript extractor snapshot",
    description: "Snitch graph derived from TypeScript source files.",
    graph: snitchGraph,
    warnings: graph.warnings
  };

  return { snapshot };
}

function extractAssistantSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();

    if (name === "agentRouter") {
      addNode(graph, {
        id: "agent:router",
        kind: "agent",
        label: "Agent router",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name
        }
      });
    }

    if (name === "assistantTools" || name.toLowerCase().includes("toolregistry")) {
      addNode(graph, {
        id: "service:tool_registry",
        kind: "service",
        label: "Tool registry",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name
        }
      });
    }
  }
}

function extractToolSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const objectLiteral = variable.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
    const toolName = objectLiteral ? getStringProperty(objectLiteral, "name") : undefined;

    if (toolName === "create_issue" || variable.getName() === "createIssueTool") {
      addNode(graph, {
        id: "tool:create_issue",
        kind: "tool",
        label: "Create issue tool",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: variable.getName(),
          capability: "external issue creation"
        }
      });
    }
  }
}

function extractSchemaSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();

    if (name === "createIssueInputSchema") {
      addNode(graph, {
        id: "schema:create_issue_input",
        kind: "schema",
        label: "CreateIssueInput schema",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name,
          fields: extractZodFields(variable)
        }
      });
    }
  }
}

function extractProviderSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() === "fetch") {
      const firstArg = call.getArguments()[0];
      const url = firstArg ? getStringLiteralValue(firstArg) : undefined;
      const host = url ? safeHost(url) : undefined;

      if (host) {
        addNode(graph, {
          id: `external:${host}`,
          kind: "external",
          label: `${host} API`,
          file,
          line: call.getStartLineNumber(),
          meta: {
            url
          }
        });
      }
    }
  }

  for (const propertyAccess of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const text = propertyAccess.getText();

    if (text.startsWith("process.env.")) {
      const envName = text.replace("process.env.", "");

      addNode(graph, {
        id: `env:${envName}`,
        kind: "env",
        label: envName,
        file,
        line: propertyAccess.getStartLineNumber(),
        meta: {
          exposure: envName.startsWith("PUBLIC_") ? "public" : "server"
        }
      });
    }
  }
}

function extractTestSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  if (!/\.(test|spec)\.[cm]?[tj]sx?$/.test(file)) {
    return;
  }

  const content = sourceFile.getFullText();

  if (content.includes("unauthorized") && content.includes("createIssue")) {
    addNode(graph, {
      id: "test:issue_tool_rejects_unauthorized",
      kind: "test",
      label: "Rejects unauthorized issue calls",
      file,
      line: 1,
      meta: {
        matcher: "unauthorized createIssue"
      }
    });
  }
}

function connectKnownIssueTool(graph: MutableGraph): void {
  if (graph.nodes.has("agent:router") && graph.nodes.has("service:tool_registry")) {
    addEdge(graph, "edge:router-uses-registry", "agent:router", "service:tool_registry", "calls");
  }

  if (graph.nodes.has("service:tool_registry") && graph.nodes.has("tool:create_issue")) {
    addEdge(
      graph,
      "edge:registry-registers-create-issue",
      "service:tool_registry",
      "tool:create_issue",
      "registers"
    );
  }

  if (graph.nodes.has("tool:create_issue") && graph.nodes.has("schema:create_issue_input")) {
    addEdge(
      graph,
      "edge:create-issue-validates-input",
      "tool:create_issue",
      "schema:create_issue_input",
      "validates"
    );
  }

  const externalNode = [...graph.nodes.keys()].find((id) => id.startsWith("external:"));

  if (graph.nodes.has("tool:create_issue") && externalNode) {
    addEdge(graph, "edge:create-issue-calls-provider", "tool:create_issue", externalNode, "calls");
  }

  if (graph.nodes.has("tool:create_issue") && graph.nodes.has("env:ISSUE_PROVIDER_API_KEY")) {
    addEdge(
      graph,
      "edge:create-issue-uses-provider-key",
      "tool:create_issue",
      "env:ISSUE_PROVIDER_API_KEY",
      "uses_secret"
    );
  }

  if (graph.nodes.has("test:issue_tool_rejects_unauthorized") && graph.nodes.has("tool:create_issue")) {
    addEdge(
      graph,
      "edge:test-covers-create-issue",
      "test:issue_tool_rejects_unauthorized",
      "tool:create_issue",
      "covers"
    );
  }
}

function attachMissingCompanionWarnings(graph: MutableGraph): void {
  if (!graph.nodes.has("tool:create_issue")) {
    return;
  }

  const externalCall = [...graph.edges.values()].find(
    (edge) => edge.from === "tool:create_issue" && edge.to.startsWith("external:")
  );

  if (!externalCall) {
    return;
  }

  const warningChecks = new Map<string, boolean>([
    ["warning:tool_audit_log_missing:create_issue", graph.nodes.has("service:tool_audit_log")],
    ["warning:secret_redaction_missing:create_issue", graph.nodes.has("service:secret_redactor")],
    [
      "warning:permission_scope_missing:create_issue",
      graph.nodes.has("contract:issue_tool_permission_scope")
    ],
    [
      "warning:unauthorized_test_missing:create_issue",
      graph.nodes.has("test:issue_tool_rejects_unauthorized")
    ]
  ]);

  for (const warning of createMissingCompanionWarnings().map((item) =>
    item.id === "warning:tool_audit_log_missing:create_issue"
      ? {
          ...item,
          evidence: [
            `tool:create_issue -> ${externalCall.to}`,
            "No service:tool_audit_log node satisfies this capability."
          ]
        }
      : item
  )) {
    if (warningChecks.get(warning.id)) {
      continue;
    }

    graph.warnings.push(warning);
    addNode(graph, {
      id: warning.id,
      kind: "warning",
      label: warning.title,
      meta: {
        severity: warning.severity,
        evidence: warning.evidence
      }
    });
    addEdge(graph, `edge:${warning.id}:missing`, "tool:create_issue", warning.id, "missing");
  }
}

function extractZodFields(variable: VariableDeclaration): string[] {
  const initializer = variable.getInitializer();

  if (!initializer) {
    return [];
  }

  const objectLiteral = initializer.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)[0];

  if (!objectLiteral) {
    return [];
  }

  return objectLiteral.getProperties().flatMap((property) => {
    if (Node.isPropertyAssignment(property)) {
      const name = property.getName();
      return name ? [name] : [];
    }

    return [];
  });
}

function getStringProperty(objectLiteral: ObjectLiteralExpression, name: string): string | undefined {
  const property = objectLiteral.getProperty(name);

  if (!property || !Node.isPropertyAssignment(property)) {
    return undefined;
  }

  return getStringLiteralValue(property.getInitializer());
}

function getStringLiteralValue(node: TsMorphNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }

  return undefined;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function relativePath(cwd: string, sourceFile: SourceFile): string {
  return relative(cwd, sourceFile.getFilePath()).replaceAll("\\", "/");
}

function addNode(
  graph: MutableGraph,
  input: {
    id: string;
    kind: NodeKind;
    label: string;
    file?: string;
    line?: number;
    meta?: Record<string, unknown>;
  }
): void {
  graph.nodes.set(input.id, {
    ...input,
    hash: hashEvidence(input)
  });
}

function addEdge(
  graph: MutableGraph,
  id: string,
  from: string,
  to: string,
  kind: GraphEdge["kind"]
): void {
  graph.edges.set(id, {
    id,
    from,
    to,
    kind,
    hash: hashEvidence({ id, from, to, kind })
  });
}
