import { relative } from "node:path";
import {
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  type CallExpression,
  type IfStatement,
  type ImportDeclaration,
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
  /** How many TypeScript source files were scanned — used to diagnose empty results. */
  sourceFileCount: number;
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

  // Scan every TypeScript source file under the target, not just `src/**`, so flat-file,
  // root-level `app/`/`pages/`, and non-standard monorepo layouts produce a real graph.
  // Heavy/generated directories are excluded so analysis stays fast and on-signal.
  project.addSourceFilesAtPaths([
    `${options.cwd}/**/*.{ts,tsx,mts,cts}`,
    `!${options.cwd}/**/node_modules/**`,
    `!${options.cwd}/**/dist/**`,
    `!${options.cwd}/**/build/**`,
    `!${options.cwd}/**/out/**`,
    `!${options.cwd}/**/.next/**`,
    `!${options.cwd}/**/.turbo/**`,
    `!${options.cwd}/**/coverage/**`,
    `!${options.cwd}/**/.snitch/**`,
    `!${options.cwd}/**/*.d.ts`
  ]);

  const graph: MutableGraph = {
    nodes: new Map(),
    edges: new Map(),
    warnings: [],
    externalAccesses: [],
    envAccesses: [],
    databaseAccesses: []
  };

  const sourceFileCount = project.getSourceFiles().length;

  for (const sourceFile of project.getSourceFiles()) {
    extractRouteSurface(options.cwd, sourceFile, graph);
    extractAssistantSurface(options.cwd, sourceFile, graph);
    extractToolSurface(options.cwd, sourceFile, graph);
    extractSchemaSurface(options.cwd, sourceFile, graph);
    extractProviderSurface(options.cwd, sourceFile, graph);
    extractDatabaseSurface(options.cwd, sourceFile, graph);
    extractCompanionSurface(options.cwd, sourceFile, graph);
    extractTestSurface(options.cwd, sourceFile, graph);
    extractAgentToolingSurface(options.cwd, sourceFile, graph);
  }

  connectKnownIssueTool(graph);
  connectFileLocalSurfaces(graph);
  connectAgentToolingSurfaces(graph);
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

  return { snapshot, sourceFileCount };
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
  const imports = collectExternalImports(sourceFile);
  const sdkInstances = collectSdkInstances(sourceFile, imports);

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const external = identifyExternalCall(call, imports, sdkInstances);

    if (external) {
      const line = call.getStartLineNumber();
      addNode(graph, {
        id: external.nodeId,
        kind: "external",
        label: external.label,
        file,
        line,
        meta: external.url ? { url: external.url, client: external.client } : { client: external.client }
      });
      graph.externalAccesses.push({ nodeId: external.nodeId, file, line });
    }
  }

  // `new Stripe(...)` / `new OpenAI(...)` etc. introduce an external capability even before
  // the first request, so record the construction site too.
  for (const newExpression of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const provider = sdkProviderForIdentifier(newExpression.getExpression().getText(), imports);

    if (provider) {
      const line = newExpression.getStartLineNumber();
      addNode(graph, {
        id: `external:${provider.slug}`,
        kind: "external",
        label: `${provider.label} API`,
        file,
        line,
        meta: { client: provider.slug }
      });
      graph.externalAccesses.push({ nodeId: `external:${provider.slug}`, file, line });
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

type ProviderInfo = { slug: string; label: string };

type ExternalImports = {
  httpClients: Set<string>;
  sdkProviders: Map<string, ProviderInfo>;
};

type ExternalCall = {
  nodeId: string;
  label: string;
  client: string;
  url?: string;
};

// Read a file's imports to learn which local identifiers are HTTP clients (axios/got/ky/…)
// or provider SDKs (stripe/openai/octokit/…). This keeps detection precise: we only treat a
// `.get()`/`.post()` as an external call when the receiver was actually imported as a client.
function collectExternalImports(sourceFile: SourceFile): ExternalImports {
  const httpClients = new Set<string>();
  const sdkProviders = new Map<string, ProviderInfo>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    const moduleName = declaration.getModuleSpecifierValue();
    const localNames = importedLocalNames(declaration);

    if (httpClientModules.has(moduleName)) {
      for (const name of localNames) {
        httpClients.add(name);
      }
      continue;
    }

    const provider = sdkModuleProvider(moduleName);

    if (provider) {
      for (const name of localNames) {
        sdkProviders.set(name, provider);
      }
    }
  }

  return { httpClients, sdkProviders };
}

function importedLocalNames(declaration: ImportDeclaration): string[] {
  const names: string[] = [];
  const defaultImport = declaration.getDefaultImport();
  const namespaceImport = declaration.getNamespaceImport();

  if (defaultImport) {
    names.push(defaultImport.getText());
  }

  if (namespaceImport) {
    names.push(namespaceImport.getText());
  }

  for (const named of declaration.getNamedImports()) {
    names.push((named.getAliasNode() ?? named.getNameNode()).getText());
  }

  return names;
}

// `const stripe = new Stripe(...)` makes `stripe` an instance of a provider SDK, so later
// `stripe.charges.create(...)` calls count as external calls to that provider.
function collectSdkInstances(sourceFile: SourceFile, imports: ExternalImports): Map<string, ProviderInfo> {
  const instances = new Map<string, ProviderInfo>();

  for (const variable of sourceFile.getVariableDeclarations()) {
    const initializer = variable.getInitializerIfKind(SyntaxKind.NewExpression);

    if (!initializer) {
      continue;
    }

    const provider = sdkProviderForIdentifier(rootIdentifierName(initializer.getExpression()), imports);

    if (provider) {
      instances.set(variable.getName(), provider);
    }
  }

  return instances;
}

function identifyExternalCall(
  call: CallExpression,
  imports: ExternalImports,
  sdkInstances: Map<string, ProviderInfo>
): ExternalCall | undefined {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();

    if (name === "fetch" || imports.httpClients.has(name)) {
      return httpExternalCall(call, name);
    }

    const provider = imports.sdkProviders.get(name);
    if (provider) {
      return sdkExternalCall(provider);
    }

    return undefined;
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const root = rootIdentifierName(expression);
    const method = expression.getName();

    if (imports.httpClients.has(root) && httpRequestMethods.has(method)) {
      return httpExternalCall(call, root);
    }

    const provider = sdkInstances.get(root) ?? imports.sdkProviders.get(root);
    if (provider) {
      return sdkExternalCall(provider);
    }
  }

  return undefined;
}

function httpExternalCall(call: CallExpression, client: string): ExternalCall {
  const urlArgument = call.getArguments().find((argument) => getStringLiteralValue(argument) !== undefined);
  const url = urlArgument ? getStringLiteralValue(urlArgument) : undefined;
  const host = url ? safeHost(url) : undefined;

  if (host && url) {
    return { nodeId: `external:${host}`, label: `${host} API`, client, url };
  }

  return { nodeId: "external:http", label: "External HTTP call", client };
}

function sdkExternalCall(provider: ProviderInfo): ExternalCall {
  return { nodeId: `external:${provider.slug}`, label: `${provider.label} API`, client: provider.slug };
}

function sdkProviderForIdentifier(name: string, imports: ExternalImports): ProviderInfo | undefined {
  return imports.sdkProviders.get(name);
}

function rootIdentifierName(node: TsMorphNode): string {
  let current: TsMorphNode | undefined = node;

  while (current && Node.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }

  return current && Node.isIdentifier(current) ? current.getText() : "";
}

function sdkModuleProvider(moduleName: string): ProviderInfo | undefined {
  for (const provider of sdkModuleProviders) {
    if (provider.test(moduleName)) {
      return { slug: provider.slug, label: provider.label };
    }
  }

  return undefined;
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

// Companion safeguards (audit logs, redactors, permission contracts) are detected by the
// *role* their symbol name implies rather than by hardcoded demo identifiers, so a repo's
// own `auditLogger` / `sanitizeInput` / `requireScope` const is recognized as protection
// instead of being reported as a missing companion.
function extractCompanionSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);

  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();
    const role = companionRoleForName(name);

    if (!role) {
      continue;
    }

    const line = variable.getStartLineNumber();

    if (role === "permission") {
      addNode(graph, {
        id: `contract:${slugId(name)}`,
        kind: "contract",
        label: humanizeId(name),
        file,
        line,
        meta: { symbol: name, role: "permission" }
      });
      continue;
    }

    addNode(graph, {
      id: `service:${slugId(name)}`,
      kind: "service",
      label: humanizeId(name),
      file,
      line,
      meta: { symbol: name, role }
    });
  }
}

type CompanionRole = "audit" | "redaction" | "permission";

function companionRoleForName(name: string): CompanionRole | undefined {
  if (/audit/i.test(name)) {
    return "audit";
  }

  if (/redact|sanitize|scrub|mask/i.test(name)) {
    return "redaction";
  }

  if (/permission|authoriz|\bscope|guard/i.test(name)) {
    return "permission";
  }

  return undefined;
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

function extractAgentToolingSurface(cwd: string, sourceFile: SourceFile, graph: MutableGraph): void {
  const file = relativePath(cwd, sourceFile);
  const scope = sourceScopeForFile(file);

  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === "runCli") {
      const cliServiceId = cliServiceNodeId(scope);

      addNode(graph, {
        id: cliServiceId,
        kind: "service",
        label: "Snitch CLI dispatcher",
        file,
        line: fn.getStartLineNumber(),
        meta: {
          symbol: "runCli",
          scope,
          surface: "cli-dispatcher"
        }
      });

      for (const ifStatement of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
        const commandName = cliCommandNameFromIfStatement(ifStatement);

        if (!commandName) {
          continue;
        }

        addNode(graph, {
          id: cliCommandNodeId(scope, commandName),
          kind: "tool",
          label: `snitch ${commandName} CLI command`,
          file,
          line: ifStatement.getStartLineNumber(),
          meta: {
            command: commandName,
            invocation: `snitch ${commandName}`,
            scope,
            surface: "cli-command",
            endLine: ifStatement.getThenStatement().getEndLineNumber()
          }
        });
      }
    }

    if (fn.getName() === "createMcpTools") {
      const mcpServiceId = mcpServiceNodeId(scope);

      addNode(graph, {
        id: mcpServiceId,
        kind: "service",
        label: "Snitch MCP server",
        file,
        line: fn.getStartLineNumber(),
        meta: {
          symbol: "createMcpTools",
          scope,
          surface: "mcp-server"
        }
      });

      for (const objectLiteral of fn.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        const toolName = getStringProperty(objectLiteral, "name");
        const title = getStringProperty(objectLiteral, "title");
        const description = getStringProperty(objectLiteral, "description");

        if (!toolName?.startsWith("snitch_") || !title || !description) {
          continue;
        }

        const cliCommand = cliCommandForMcpTool(toolName);

        addNode(graph, {
          id: mcpToolNodeId(scope, toolName),
          kind: "tool",
          label: title,
          file,
          line: objectLiteral.getStartLineNumber(),
          meta: {
            cliCommand,
            scope,
            surface: "mcp-tool",
            toolName
          }
        });
      }
    }
  }
}

function cliCommandNameFromIfStatement(ifStatement: IfStatement): string | undefined {
  const expression = ifStatement.getExpression();

  if (!Node.isBinaryExpression(expression)) {
    return undefined;
  }

  const operator = expression.getOperatorToken().getKind();

  if (operator !== SyntaxKind.EqualsEqualsEqualsToken && operator !== SyntaxKind.EqualsEqualsToken) {
    return undefined;
  }

  const leftText = expression.getLeft().getText();
  const rightText = expression.getRight().getText();
  const leftString = getStringLiteralValue(expression.getLeft());
  const rightString = getStringLiteralValue(expression.getRight());

  if (leftText === "command" && rightString) {
    return rightString;
  }

  if (rightText === "command" && leftString) {
    return leftString;
  }

  return undefined;
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

function connectAgentToolingSurfaces(graph: MutableGraph): void {
  for (const node of graph.nodes.values()) {
    if (node.kind !== "tool") {
      continue;
    }

    const scope = typeof node.meta?.scope === "string" ? node.meta.scope : undefined;

    if (!scope) {
      continue;
    }

    const cliServiceId = cliServiceNodeId(scope);
    const mcpServiceId = mcpServiceNodeId(scope);

    if (node.meta?.surface === "cli-command" && graph.nodes.has(cliServiceId)) {
      addEdgeIfMissing(
        graph,
        `edge:snitch-cli-registers-${edgeIdPart(node.id)}`,
        cliServiceId,
        node.id,
        "registers"
      );
    }

    if (node.meta?.surface === "mcp-tool" && graph.nodes.has(mcpServiceId)) {
      addEdgeIfMissing(
        graph,
        `edge:snitch-mcp-registers-${edgeIdPart(node.id)}`,
        mcpServiceId,
        node.id,
        "registers"
      );

      if (typeof node.meta.cliCommand === "string") {
        const cliNodeId = cliCommandNodeId(scope, node.meta.cliCommand);

        if (graph.nodes.has(cliNodeId)) {
          addEdgeIfMissing(
            graph,
            `edge:${edgeIdPart(node.id)}-calls-${edgeIdPart(cliNodeId)}`,
            node.id,
            cliNodeId,
            "calls"
          );
        }
      }
    }
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
  // Any actor that reaches an external system needs the same safeguards, whether it is an
  // agent tool or an HTTP route handler. Routes that call a provider with a secret were
  // previously invisible to the warning engine.
  const actors = [...graph.nodes.values()].filter(
    (node) => node.kind === "tool" || node.kind === "endpoint"
  );

  for (const actor of actors) {
    const externalCall = [...graph.edges.values()].find(
      (edge) => edge.from === actor.id && edge.to.startsWith("external:") && edge.kind === "calls"
    );

    if (!externalCall) {
      continue;
    }

    for (const warning of missingCompanionWarningsForActor(graph, actor, externalCall.to)) {
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
      addEdge(graph, `edge:${warning.id}:missing`, actor.id, warning.id, "missing");
    }
  }
}

function actorSlug(actor: GraphNode): string {
  return slugId(actor.id.replace(/^(tool|endpoint|service):/, ""));
}

function missingCompanionWarningsForActor(
  graph: MutableGraph,
  actor: GraphNode,
  externalNodeId: string
): SnitchWarning[] {
  const slug = actorSlug(actor);
  const canonicalWarnings = actor.id === "tool:create_issue"
    ? createIssueWarnings(externalNodeId)
    : createGenericToolWarnings(actor, externalNodeId);
  const warningSatisfied = new Map<string, boolean>([
    [`warning:tool_audit_log_missing:${slug}`, hasCompanionRole(graph, "audit")],
    [`warning:secret_redaction_missing:${slug}`, hasCompanionRole(graph, "redaction")],
    [`warning:permission_scope_missing:${slug}`, hasPermissionScopeForTool(graph, slug)],
    [`warning:unauthorized_test_missing:${slug}`, hasUnauthorizedTestForTool(graph, slug)]
  ]);

  return canonicalWarnings.filter((warning) => !warningSatisfied.get(warning.id));
}

function hasCompanionRole(graph: MutableGraph, role: CompanionRole): boolean {
  return [...graph.nodes.values()].some((node) => node.meta?.role === role);
}

function createIssueWarnings(externalNodeId: string): SnitchWarning[] {
  return createMissingCompanionWarnings().map((item) =>
    item.id === "warning:tool_audit_log_missing:create_issue"
      ? {
          ...item,
          evidence: [
            `tool:create_issue -> ${externalNodeId}`,
            "No service:tool_audit_log node satisfies this capability."
          ]
        }
      : item
  );
}

function createGenericToolWarnings(tool: GraphNode, externalNodeId: string): SnitchWarning[] {
  const toolSlug = actorSlug(tool);
  const toolLabelText = tool.label;

  return [
    {
      id: `warning:tool_audit_log_missing:${toolSlug}`,
      kind: "warning",
      severity: "high",
      title: `No audit trail for ${toolLabelText}`,
      message: `${toolLabelText} calls an external system but no audit log node records the call.`,
      evidence: [
        `${tool.id} -> ${externalNodeId}`,
        "No service:tool_audit_log node satisfies this capability."
      ],
      repairPrompt: `Add an audit log write around ${toolSlug} calls. Record caller, task/session id, external target, redacted payload summary, status, and timestamp.`
    },
    {
      id: `warning:secret_redaction_missing:${toolSlug}`,
      kind: "warning",
      severity: "high",
      title: `No redaction boundary for ${toolLabelText}`,
      message: `${toolLabelText} sends data to an external system but no redaction service is connected to the tool boundary.`,
      evidence: [
        `${tool.id} -> ${externalNodeId}`,
        `No service:secret_redactor node is connected to ${tool.id}.`
      ],
      repairPrompt: `Add a redaction boundary before ${toolSlug} writes audit records or returns external-provider errors to the agent transcript.`
    },
    {
      id: `warning:permission_scope_missing:${toolSlug}`,
      kind: "warning",
      severity: "medium",
      title: `No permission scope for ${toolLabelText}`,
      message: `${toolLabelText} exposes an external capability without a scoped permission contract.`,
      evidence: [
        `${tool.id} calls ${externalNodeId}`,
        `No contract node satisfies ${tool.id}.`
      ],
      repairPrompt: `Require a scoped permission grant before ${toolSlug} can call the external system. Tie the grant to this task or session.`
    },
    {
      id: `warning:unauthorized_test_missing:${toolSlug}`,
      kind: "warning",
      severity: "medium",
      title: `No unauthorized-call test for ${toolLabelText}`,
      message: `The graph has no test proving ${toolLabelText} rejects unauthorized callers.`,
      evidence: [
        `${tool.id} has no covers edge from a test node`,
        `Expected unauthorized-call coverage for ${tool.id}.`
      ],
      repairPrompt: `Add a test that calls ${toolSlug} without permission and asserts that no external request is made.`
    }
  ];
}

function hasPermissionScopeForTool(graph: MutableGraph, toolSlug: string): boolean {
  if (toolSlug === "create_issue" && graph.nodes.has("contract:issue_tool_permission_scope")) {
    return true;
  }

  return [...graph.nodes.values()].some(
    (node) =>
      (node.kind === "contract" || node.meta?.role === "permission") &&
      (node.meta?.role === "permission" ||
        node.id.includes(toolSlug) ||
        String(node.meta?.symbol ?? "").toLowerCase().includes(toolSlug))
  );
}

function hasUnauthorizedTestForTool(graph: MutableGraph, toolSlug: string): boolean {
  if (toolSlug === "create_issue" && graph.nodes.has("test:issue_tool_rejects_unauthorized")) {
    return true;
  }

  return [...graph.nodes.values()].some(
    (node) =>
      node.kind === "test" &&
      (node.id.includes(toolSlug) || String(node.meta?.matcher ?? "").toLowerCase().includes(toolSlug))
  );
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

// HTTP client libraries whose calls (`axios.post(...)`, `got(...)`, `ky.get(...)`) reach an
// external system just like `fetch` does.
const httpClientModules = new Set([
  "axios",
  "got",
  "ky",
  "node-fetch",
  "undici",
  "superagent",
  "phin",
  "needle",
  "redaxios"
]);
const httpRequestMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);

// Provider SDKs that imply an external capability when imported and constructed/used.
const sdkModuleProviders: Array<{ test: (moduleName: string) => boolean; slug: string; label: string }> = [
  { test: (moduleName) => moduleName === "stripe", slug: "stripe", label: "Stripe" },
  { test: (moduleName) => moduleName === "openai", slug: "openai", label: "OpenAI" },
  { test: (moduleName) => moduleName === "@anthropic-ai/sdk", slug: "anthropic", label: "Anthropic" },
  { test: (moduleName) => moduleName === "octokit" || moduleName.startsWith("@octokit/"), slug: "github", label: "GitHub" },
  { test: (moduleName) => moduleName === "twilio", slug: "twilio", label: "Twilio" },
  { test: (moduleName) => moduleName === "@sendgrid/mail", slug: "sendgrid", label: "SendGrid" },
  { test: (moduleName) => moduleName === "resend", slug: "resend", label: "Resend" },
  { test: (moduleName) => moduleName === "aws-sdk" || moduleName.startsWith("@aws-sdk/"), slug: "aws", label: "AWS" },
  { test: (moduleName) => moduleName === "cohere-ai", slug: "cohere", label: "Cohere" },
  { test: (moduleName) => moduleName === "replicate", slug: "replicate", label: "Replicate" },
  { test: (moduleName) => moduleName === "@slack/web-api", slug: "slack", label: "Slack" },
  { test: (moduleName) => moduleName === "@notionhq/client", slug: "notion", label: "Notion" },
  { test: (moduleName) => moduleName === "@linear/sdk", slug: "linear", label: "Linear" },
  { test: (moduleName) => moduleName.startsWith("@google-cloud/"), slug: "gcp", label: "Google Cloud" }
];

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

function cliServiceNodeId(scope: string): string {
  return `service:${scope}_snitch_cli`;
}

function mcpServiceNodeId(scope: string): string {
  return `service:${scope}_snitch_mcp_server`;
}

function cliCommandNodeId(scope: string, commandName: string): string {
  return `tool:${scope}_cli_${slugId(commandName)}`;
}

function mcpToolNodeId(scope: string, toolName: string): string {
  return `tool:${scope}_${slugId(toolName)}`;
}

function cliCommandForMcpTool(toolName: string): string {
  return toolName.replace(/^snitch_/, "").replaceAll("_", "-");
}

function sourceScopeForFile(file: string): string {
  const withoutExtension = file.replace(/\.[cm]?[tj]sx?$/, "");
  const withoutSourceSegment = withoutExtension.replace(/(^|\/)(src|tests)\//g, "$1");

  return slugId(withoutSourceSegment);
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
