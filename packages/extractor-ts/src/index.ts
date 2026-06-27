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
  externalAccesses: GraphAccess[];
  envAccesses: GraphAccess[];
  databaseAccesses: DatabaseAccess[];
};

type GraphAccess = {
  nodeId: string;
  file: string;
  line: number;
};

type DatabaseAccess = GraphAccess & {
  edgeKind: "reads" | "writes";
};

type DatabaseCall = {
  source: "prisma" | "drizzle" | "supabase";
  entity: string;
  operation: string;
  edgeKind: "reads" | "writes";
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
    warnings: [],
    externalAccesses: [],
    envAccesses: [],
    databaseAccesses: []
  };

  for (const sourceFile of project.getSourceFiles()) {
    extractRouteSurface(options.cwd, sourceFile, graph);
    extractAssistantSurface(options.cwd, sourceFile, graph);
    extractToolSurface(options.cwd, sourceFile, graph);
    extractSchemaSurface(options.cwd, sourceFile, graph);
    extractProviderSurface(options.cwd, sourceFile, graph);
    extractDatabaseSurface(options.cwd, sourceFile, graph);
    extractCompanionSurface(options.cwd, sourceFile, graph);
    extractTestSurface(options.cwd, sourceFile, graph);
  }

  connectKnownIssueTool(graph);
  connectFileLocalSurfaces(graph);
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

function extractRouteSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);
  const routePath = routePathFromFile(file);

  if (!routePath) {
    return;
  }

  for (const handler of sourceFile.getFunctions()) {
    const method = handler.getName();

    if (!method || !httpMethods.has(method)) {
      continue;
    }

    addNode(graph, {
      id: `endpoint:${method}:${routePath}`,
      kind: "endpoint",
      label: `${method} ${routePath}`,
      file,
      line: handler.getStartLineNumber(),
      meta: {
        endLine: handler.getEndLineNumber(),
        method,
        route: routePath,
        runtime: "next-route-handler"
      }
    });
  }
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

    if ((toolName && looksLikeToolObject(variable, objectLiteral)) || variable.getName() === "createIssueTool") {
      const canonicalToolName = toolName ?? "create_issue";
      addToolNode(graph, {
        name: canonicalToolName,
        file,
        line: variable.getStartLineNumber(),
        endLine: variable.getEndLineNumber(),
        symbol: variable.getName(),
        inputSchemaSymbol: objectLiteral ? getExpressionPropertyText(objectLiteral, "inputSchema") : undefined
      });
    }

    const toolCall = variable.getInitializerIfKind(SyntaxKind.CallExpression);

    if (toolCall && looksLikeToolRegistrationCall(toolCall)) {
      addToolNodeFromCall(graph, file, toolCall, variable.getName());
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isVariableInitializer(call) || !looksLikeToolRegistrationCall(call)) {
      continue;
    }

    addToolNodeFromCall(graph, file, call);
  }
}

function addToolNodeFromCall(
  graph: MutableGraph,
  file: string,
  call: CallExpression,
  fallbackSymbol?: string
): void {
  const name = toolNameFromRegistrationCall(call, fallbackSymbol);
  const schema = getToolCallSchema(call, name);
  const toolId = toolIdForName(name);

  addToolNode(graph, {
    name,
    file,
    line: call.getStartLineNumber(),
    endLine: call.getEndLineNumber(),
    symbol: fallbackSymbol,
    inputSchemaSymbol: schema.inputSchemaSymbol
  });

  if (schema.inlineFields.length === 0) {
    return;
  }

  const schemaId = schemaIdForName(`${name}_input`);
  addNode(graph, {
    id: schemaId,
    kind: "schema",
    label: `${toolLabel(name)} input schema`,
    file,
    line: schema.line ?? call.getStartLineNumber(),
    meta: {
      fields: schema.inlineFields,
      source: "inline-tool-schema"
    }
  });
  addEdgeIfMissing(
    graph,
    `edge:${edgeIdPart(toolId)}-validates-${edgeIdPart(schemaId)}`,
    toolId,
    schemaId,
    "validates"
  );
}

function addToolNode(
  graph: MutableGraph,
  input: {
    name: string;
    file: string;
    line: number;
    endLine: number;
    symbol?: string | undefined;
    inputSchemaSymbol?: string | undefined;
  }
): void {
  addNode(graph, {
    id: toolIdForName(input.name),
    kind: "tool",
    label: toolLabel(input.name),
    file: input.file,
    line: input.line,
    meta: {
      endLine: input.endLine,
      symbol: input.symbol,
      capability: inferToolCapability(input.name),
      inputSchemaSymbol: input.inputSchemaSymbol
    }
  });
}

function getToolCallSchema(call: CallExpression, toolName: string): {
  inputSchemaSymbol?: string | undefined;
  inlineFields: string[];
  line?: number | undefined;
} {
  for (const argument of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(argument)) {
      continue;
    }

    const inputSchema = argument.getProperty("inputSchema");

    if (inputSchema && Node.isPropertyAssignment(inputSchema)) {
      const initializer = inputSchema.getInitializer();
      const inlineFields = extractSchemaFieldsFromExpression(initializer);

      return {
        inputSchemaSymbol: inlineFields.length > 0 ? undefined : schemaSymbolFromExpression(initializer),
        inlineFields,
        line: initializer?.getStartLineNumber()
      };
    }

    const inlineFields = extractFieldsFromObjectLiteral(argument);

    if (inlineFields.length > 0) {
      return {
        inlineFields,
        line: argument.getStartLineNumber()
      };
    }
  }

  for (const argument of call.getArguments()) {
    const inlineFields = extractSchemaFieldsFromExpression(argument);

    if (inlineFields.length > 0) {
      return {
        inlineFields,
        line: argument.getStartLineNumber()
      };
    }

    const symbol = schemaSymbolFromExpression(argument);

    if (symbol && symbol !== toolName) {
      return {
        inputSchemaSymbol: symbol,
        inlineFields: [],
        line: argument.getStartLineNumber()
      };
    }
  }

  return {
    inlineFields: []
  };
}

function extractSchemaSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();

    if (looksLikeZodSchema(variable)) {
      const schemaId = schemaIdForName(name);
      addNode(graph, {
        id: schemaId,
        kind: "schema",
        label: schemaLabel(name),
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
        const line = call.getStartLineNumber();
        addNode(graph, {
          id: `external:${host}`,
          kind: "external",
          label: `${host} API`,
          file,
          line,
          meta: {
            url
          }
        });
        graph.externalAccesses.push({ nodeId: `external:${host}`, file, line });
      }
    }
  }

  for (const propertyAccess of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const text = propertyAccess.getText();

    if (text.startsWith("process.env.")) {
      const envName = text.replace("process.env.", "");
      const line = propertyAccess.getStartLineNumber();

      addNode(graph, {
        id: `env:${envName}`,
        kind: "env",
        label: envName,
        file,
        line,
        meta: {
          exposure: envName.startsWith("PUBLIC_") ? "public" : "server"
        }
      });
      graph.envAccesses.push({ nodeId: `env:${envName}`, file, line });
    }
  }
}

function extractDatabaseSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const databaseCall = getDatabaseCall(call);

    if (!databaseCall) {
      continue;
    }

    const nodeId = databaseNodeId(databaseCall);
    const line = call.getStartLineNumber();

    addNode(graph, {
      id: nodeId,
      kind: "database",
      label: databaseLabel(databaseCall),
      file,
      line,
      meta: {
        source: databaseCall.source,
        entity: databaseCall.entity,
        operation: databaseCall.operation
      }
    });
    graph.databaseAccesses.push({
      nodeId,
      file,
      line,
      edgeKind: databaseCall.edgeKind
    });
  }
}

function extractCompanionSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();
    const lowerName = name.toLowerCase();

    if (name === "toolAuditLog" || lowerName.includes("toolauditlog")) {
      addNode(graph, {
        id: "service:tool_audit_log",
        kind: "service",
        label: "Tool audit log",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name,
          records: "external tool calls"
        }
      });
    }

    if (name === "secretRedactor" || lowerName.includes("secretredactor")) {
      addNode(graph, {
        id: "service:secret_redactor",
        kind: "service",
        label: "Secret redactor",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name,
          scope: "tool inputs and provider responses"
        }
      });
    }

    if (name === "issueToolPermissionScope" || name === "createIssuePermissionScope") {
      addNode(graph, {
        id: "contract:issue_tool_permission_scope",
        kind: "contract",
        label: "Per-session permission scope",
        file,
        line: variable.getStartLineNumber(),
        meta: {
          symbol: name,
          rule: "external issue creation requires scoped approval"
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

  if (graph.nodes.has("tool:create_issue") && graph.nodes.has("service:tool_audit_log")) {
    addEdge(
      graph,
      "edge:create-issue-writes-audit",
      "tool:create_issue",
      "service:tool_audit_log",
      "writes"
    );
  }

  if (graph.nodes.has("tool:create_issue") && graph.nodes.has("service:secret_redactor")) {
    addEdge(
      graph,
      "edge:create-issue-calls-redactor",
      "tool:create_issue",
      "service:secret_redactor",
      "calls"
    );
  }

  if (graph.nodes.has("tool:create_issue") && graph.nodes.has("contract:issue_tool_permission_scope")) {
    addEdge(
      graph,
      "edge:create-issue-satisfies-permission",
      "tool:create_issue",
      "contract:issue_tool_permission_scope",
      "satisfies"
    );
  }
}

function connectFileLocalSurfaces(graph: MutableGraph): void {
  const nodes = [...graph.nodes.values()];
  const actors = nodes.filter((node) => node.kind === "tool" || node.kind === "endpoint");
  const schemas = nodes.filter((node) => node.kind === "schema");

  for (const actor of actors) {
    if (!actor.file) {
      continue;
    }

    if (actor.kind === "tool" && typeof actor.meta?.inputSchemaSymbol === "string") {
      const schema = schemas.find((candidate) => candidate.meta?.symbol === actor.meta?.inputSchemaSymbol);

      if (schema) {
        addEdgeIfMissing(
          graph,
          `edge:${edgeIdPart(actor.id)}-validates-${edgeIdPart(schema.id)}`,
          actor.id,
          schema.id,
          "validates"
        );
      }
    }

    for (const external of graph.externalAccesses.filter((access) => isAccessInActorRange(actor, access))) {
      addEdgeIfMissing(
        graph,
        `edge:${edgeIdPart(actor.id)}-calls-${edgeIdPart(external.nodeId)}`,
        actor.id,
        external.nodeId,
        "calls"
      );
    }

    for (const envVar of graph.envAccesses.filter((access) => isAccessInActorRange(actor, access))) {
      addEdgeIfMissing(
        graph,
        `edge:${edgeIdPart(actor.id)}-uses-${edgeIdPart(envVar.nodeId)}`,
        actor.id,
        envVar.nodeId,
        "uses_secret"
      );
    }

    for (const database of graph.databaseAccesses.filter((access) => isAccessInActorRange(actor, access))) {
      addEdgeIfMissing(
        graph,
        `edge:${edgeIdPart(actor.id)}-${database.edgeKind}-${edgeIdPart(database.nodeId)}`,
        actor.id,
        database.nodeId,
        database.edgeKind
      );
    }
  }
}

function isAccessInActorRange(actor: GraphNode, access: GraphAccess): boolean {
  if (access.file !== actor.file) {
    return false;
  }

  const endLine = typeof actor.meta?.endLine === "number" ? actor.meta.endLine : actor.line;

  if (!actor.line || !endLine) {
    return true;
  }

  return access.line >= actor.line && access.line <= endLine;
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

function getExpressionPropertyText(objectLiteral: ObjectLiteralExpression, name: string): string | undefined {
  const property = objectLiteral.getProperty(name);

  if (!property || !Node.isPropertyAssignment(property)) {
    return undefined;
  }

  return property.getInitializer()?.getText();
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

function getDatabaseCall(call: CallExpression): DatabaseCall | undefined {
  return getPrismaCall(call) ?? getDrizzleCall(call) ?? getSupabaseCall(call);
}

function getPrismaCall(call: CallExpression): DatabaseCall | undefined {
  const expressionText = call.getExpression().getText();
  const match = expressionText.match(/(?:^|\.)prisma\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);

  if (!match?.[1] || !match[2] || !databaseMethods.has(match[2])) {
    return undefined;
  }

  return {
    source: "prisma",
    entity: match[1],
    operation: match[2],
    edgeKind: writeDatabaseMethods.has(match[2]) ? "writes" : "reads"
  };
}

function getDrizzleCall(call: CallExpression): DatabaseCall | undefined {
  const expressionText = call.getExpression().getText();
  const writeMatch = expressionText.match(/(?:^|\.)db\.(insert|update|delete)$/);

  if (writeMatch?.[1]) {
    const entity = getDatabaseEntityFromArgument(call.getArguments()[0]);

    if (entity) {
      return {
        source: "drizzle",
        entity,
        operation: writeMatch[1],
        edgeKind: "writes"
      };
    }
  }

  if (expressionText.endsWith(".from") && expressionText.includes("db.select(")) {
    const entity = getDatabaseEntityFromArgument(call.getArguments()[0]);

    if (entity) {
      return {
        source: "drizzle",
        entity,
        operation: "select",
        edgeKind: "reads"
      };
    }
  }

  const queryMatch = expressionText.match(/(?:^|\.)db\.query\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);

  if (queryMatch?.[1] && queryMatch[2] && readDatabaseMethods.has(queryMatch[2])) {
    return {
      source: "drizzle",
      entity: queryMatch[1],
      operation: queryMatch[2],
      edgeKind: "reads"
    };
  }

  return undefined;
}

function getSupabaseCall(call: CallExpression): DatabaseCall | undefined {
  const callText = call.getText();
  const match = callText.match(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\).*?\.(select|insert|update|upsert|delete)\s*\(/);

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    source: "supabase",
    entity: match[1],
    operation: match[2],
    edgeKind: match[2] === "select" ? "reads" : "writes"
  };
}

function getDatabaseEntityFromArgument(node: TsMorphNode | undefined): string | undefined {
  const literal = getStringLiteralValue(node);

  if (literal) {
    return literal;
  }

  const text = node?.getText();

  if (!text || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
    return undefined;
  }

  return text;
}

const readDatabaseMethods = new Set(["aggregate", "count", "findFirst", "findMany", "findUnique", "groupBy"]);
const writeDatabaseMethods = new Set(["create", "createMany", "delete", "deleteMany", "insert", "update", "updateMany", "upsert"]);
const databaseMethods = new Set([...readDatabaseMethods, ...writeDatabaseMethods]);
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const toolFactoryNames = new Set(["tool", "createTool", "defineTool"]);
const toolRegistrationMethods = new Set(["tool", "registerTool"]);

function routePathFromFile(file: string): string | undefined {
  const normalized = file.replaceAll("\\", "/");
  const match = normalized.match(/^(?:src\/)?app\/api\/(.+)\/route\.[cm]?[tj]sx?$/);

  if (!match?.[1]) {
    return undefined;
  }

  return `/api/${match[1]}`;
}

function looksLikeZodSchema(variable: VariableDeclaration): boolean {
  const name = variable.getName();
  const initializerText = variable.getInitializer()?.getText() ?? "";

  return /schema$/i.test(name) && /\bz\.object\s*\(/.test(initializerText);
}

function looksLikeToolObject(
  variable: VariableDeclaration,
  objectLiteral: ObjectLiteralExpression | undefined
): boolean {
  if (!objectLiteral) {
    return false;
  }

  const variableName = variable.getName().toLowerCase();

  return variableName.includes("tool")
    || Boolean(objectLiteral.getProperty("execute"))
    || Boolean(objectLiteral.getProperty("inputSchema"));
}

function looksLikeToolRegistrationCall(call: CallExpression): boolean {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    return toolFactoryNames.has(expression.getText());
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return toolRegistrationMethods.has(expression.getName());
  }

  return false;
}

function toolNameFromRegistrationCall(call: CallExpression, fallbackSymbol?: string): string {
  const firstStringArg = getStringLiteralValue(call.getArguments()[0]);

  if (firstStringArg) {
    return firstStringArg;
  }

  for (const argument of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(argument)) {
      continue;
    }

    const name = getStringProperty(argument, "name");

    if (name) {
      return name;
    }
  }

  return fallbackSymbol ?? "registered_tool";
}

function isVariableInitializer(call: CallExpression): boolean {
  return Node.isVariableDeclaration(call.getParent());
}

function extractSchemaFieldsFromExpression(node: TsMorphNode | undefined): string[] {
  if (!node) {
    return [];
  }

  if (Node.isObjectLiteralExpression(node)) {
    return extractFieldsFromObjectLiteral(node);
  }

  if (Node.isCallExpression(node) && node.getExpression().getText() === "z.object") {
    const objectLiteral = node.getArguments().find(Node.isObjectLiteralExpression);
    return objectLiteral ? extractFieldsFromObjectLiteral(objectLiteral) : [];
  }

  return [];
}

function extractFieldsFromObjectLiteral(objectLiteral: ObjectLiteralExpression): string[] {
  return objectLiteral.getProperties().flatMap((property) => {
    if (!Node.isPropertyAssignment(property)) {
      return [];
    }

    const initializerText = property.getInitializer()?.getText() ?? "";

    if (!/\bz\.[A-Za-z0-9_]+\s*\(/.test(initializerText)) {
      return [];
    }

    const name = property.getName();
    return name ? [name] : [];
  });
}

function schemaSymbolFromExpression(node: TsMorphNode | undefined): string | undefined {
  if (!node || !Node.isIdentifier(node)) {
    return undefined;
  }

  const text = node.getText();
  return /schema$/i.test(text) ? text : undefined;
}

function toolIdForName(name: string): string {
  return `tool:${slugId(name)}`;
}

function schemaIdForName(name: string): string {
  return `schema:${slugId(name.replace(/Schema$/i, ""))}`;
}

function toolLabel(name: string): string {
  if (name === "create_issue") {
    return "Create issue tool";
  }

  return `${humanizeId(name)} tool`;
}

function schemaLabel(name: string): string {
  if (name === "createIssueInputSchema") {
    return "CreateIssueInput schema";
  }

  return `${name} schema`;
}

function databaseNodeId(databaseCall: DatabaseCall): string {
  return `database:${slugId(databaseCall.source)}_${slugId(databaseCall.entity)}`;
}

function databaseLabel(databaseCall: DatabaseCall): string {
  return `${humanizeId(databaseCall.entity)} ${databaseCall.source} ${databaseCall.edgeKind === "reads" ? "read" : "write"}`;
}

function inferToolCapability(name: string): string {
  return name === "create_issue" ? "external issue creation" : humanizeId(name).toLowerCase();
}

function humanizeId(value: string): string {
  const words = slugId(value).split("_").filter(Boolean);

  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function slugId(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function edgeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
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

function addEdgeIfMissing(
  graph: MutableGraph,
  id: string,
  from: string,
  to: string,
  kind: GraphEdge["kind"]
): void {
  const exists = [...graph.edges.values()].some(
    (edge) => edge.from === from && edge.to === to && edge.kind === kind
  );

  if (!exists) {
    addEdge(graph, id, from, to, kind);
  }
}
