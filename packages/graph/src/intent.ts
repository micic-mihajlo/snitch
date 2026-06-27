import type { EdgeKind, GraphEdge, GraphNode, NodeKind, SnitchGraph, SnitchWarning } from "./types";

export type IntentCoverageStatus = "covered" | "partial" | "missing" | "unclassified";

export type IntentRequirementStatus = "met" | "missing";

export type IntentRequirementKind = NodeKind | EdgeKind;

export type IntentRequirement = {
  id: string;
  capabilityId: string;
  capabilityLabel: string;
  kind: IntentRequirementKind;
  label: string;
  status: IntentRequirementStatus;
  matchedNodeIds: string[];
  matchedEdgeIds: string[];
  evidence: string[];
  repairHint: string;
};

export type IntentCapability = {
  id: string;
  label: string;
  matchedTerms: string[];
};

export type IntentCoverage = {
  task: string;
  status: IntentCoverageStatus;
  capabilities: IntentCapability[];
  requirements: IntentRequirement[];
  relatedWarnings: Array<{
    id: string;
    severity: SnitchWarning["severity"];
    title: string;
    repairCommand: string;
  }>;
  summary: {
    capabilities: number;
    requirements: number;
    met: number;
    missing: number;
    warnings: number;
  };
  narrative: string[];
};

type CapabilityDefinition = {
  id: string;
  label: string;
  terms: RegExp[];
  requirements: RequirementDefinition[];
};

type RequirementDefinition = {
  id: string;
  kind: IntentRequirementKind;
  label: string;
  repairHint: string;
  evaluate: (context: IntentContext) => RequirementMatch;
};

type RequirementMatch = {
  nodeIds?: string[];
  edgeIds?: string[];
  evidence?: string[];
};

type IntentContext = {
  graph: SnitchGraph;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export function inferIntentCapabilities(task: string): IntentCapability[] {
  const normalizedTask = normalizeText(task);

  return capabilityDefinitions
    .map((definition) => {
      const matchedTerms = definition.terms
        .filter((term) => term.test(normalizedTask))
        .map((term) => term.source.replaceAll("\\b", ""));

      return matchedTerms.length > 0
        ? {
            id: definition.id,
            label: definition.label,
            matchedTerms
          }
        : undefined;
    })
    .filter((capability): capability is IntentCapability => Boolean(capability));
}

export function verifyIntentCoverage(
  graph: SnitchGraph,
  warnings: SnitchWarning[],
  task: string
): IntentCoverage {
  const capabilities = inferIntentCapabilities(task);

  if (capabilities.length === 0) {
    return {
      task,
      status: "unclassified",
      capabilities: [],
      requirements: [],
      relatedWarnings: [],
      summary: {
        capabilities: 0,
        requirements: 0,
        met: 0,
        missing: 0,
        warnings: 0
      },
      narrative: [
        "Snitch could not map this task to a built-in intent profile yet.",
        "Run normal graph checks and inspect active findings."
      ]
    };
  }

  const context: IntentContext = {
    graph,
    nodes: graph.nodes,
    edges: graph.edges
  };
  const requirements = capabilities.flatMap((capability) => {
    const definition = capabilityDefinitions.find((item) => item.id === capability.id);

    if (!definition) {
      return [];
    }

    return definition.requirements.map((requirement) =>
      evaluateRequirement(capability, requirement, context)
    );
  });
  const missing = requirements.filter((requirement) => requirement.status === "missing");
  const relatedWarnings = relatedIntentWarnings(warnings, capabilities);
  const status = missing.length === 0 && relatedWarnings.length === 0
    ? "covered"
    : requirements.some((requirement) => requirement.status === "met")
      ? "partial"
      : "missing";

  return {
    task,
    status,
    capabilities,
    requirements,
    relatedWarnings,
    summary: {
      capabilities: capabilities.length,
      requirements: requirements.length,
      met: requirements.length - missing.length,
      missing: missing.length,
      warnings: relatedWarnings.length
    },
    narrative: buildIntentNarrative(capabilities, requirements, relatedWarnings, status)
  };
}

function evaluateRequirement(
  capability: IntentCapability,
  requirement: RequirementDefinition,
  context: IntentContext
): IntentRequirement {
  const match = requirement.evaluate(context);
  const matchedNodeIds = match.nodeIds ?? [];
  const matchedEdgeIds = match.edgeIds ?? [];
  const evidence = match.evidence ?? [
    ...matchedNodeIds.map((id) => `node:${id}`),
    ...matchedEdgeIds.map((id) => `edge:${id}`)
  ];
  const status = matchedNodeIds.length > 0 || matchedEdgeIds.length > 0 ? "met" : "missing";

  return {
    id: `${capability.id}:${requirement.id}`,
    capabilityId: capability.id,
    capabilityLabel: capability.label,
    kind: requirement.kind,
    label: requirement.label,
    status,
    matchedNodeIds,
    matchedEdgeIds,
    evidence: status === "met" ? evidence : [],
    repairHint: requirement.repairHint
  };
}

function relatedIntentWarnings(
  warnings: SnitchWarning[],
  capabilities: IntentCapability[]
): IntentCoverage["relatedWarnings"] {
  const tokens = capabilities.flatMap((capability) => intentTokens(capability.id));

  return warnings
    .filter((warning) => {
      const text = normalizeText(`${warning.id} ${warning.title} ${warning.message}`);
      return tokens.some((token) => text.includes(token));
    })
    .map((warning) => ({
      id: warning.id,
      severity: warning.severity,
      title: warning.title,
      repairCommand: `pnpm snitch repair-prompt --warning ${warning.id}`
    }));
}

function buildIntentNarrative(
  capabilities: IntentCapability[],
  requirements: IntentRequirement[],
  warnings: IntentCoverage["relatedWarnings"],
  status: IntentCoverageStatus
): string[] {
  const capabilityText = capabilities.map((capability) => capability.label).join(", ");
  const met = requirements.filter((requirement) => requirement.status === "met");
  const missing = requirements.filter((requirement) => requirement.status === "missing");

  if (status === "covered") {
    return [
      `Snitch matched the task to ${capabilityText}.`,
      "All inferred intent requirements are present in the current graph."
    ];
  }

  return [
    `Snitch matched the task to ${capabilityText}.`,
    `${met.length} requirement(s) are present; ${missing.length} requirement(s) are missing.`,
    warnings.length > 0
      ? `${warnings.length} related warning(s) still need repair.`
      : "No related warnings are active."
  ];
}

function nodeMatch(
  context: IntentContext,
  kind: NodeKind,
  matcher: (text: string, node: GraphNode) => boolean
): RequirementMatch {
  const nodes = context.nodes.filter((node) => node.kind === kind && matcher(nodeText(node), node));

  return {
    nodeIds: nodes.map((node) => node.id),
    evidence: nodes.map(formatNodeEvidence)
  };
}

function edgeMatch(
  context: IntentContext,
  kind: EdgeKind,
  matcher: (edge: GraphEdge) => boolean
): RequirementMatch {
  const edges = context.edges.filter((edge) => edge.kind === kind && matcher(edge));

  return {
    edgeIds: edges.map((edge) => edge.id),
    evidence: edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`)
  };
}

function formatNodeEvidence(node: GraphNode): string {
  const location = node.file ? ` at ${node.file}${node.line ? `:${node.line}` : ""}` : "";
  return `${node.id}${location}`;
}

function nodeText(node: GraphNode): string {
  return normalizeText(`${node.id} ${node.label} ${JSON.stringify(node.meta ?? {})}`);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_./:-]+/g, " ").trim();
}

function intentTokens(capabilityId: string): string[] {
  if (capabilityId === "issue_creation") {
    return ["issue", "github", "ticket"];
  }

  if (capabilityId === "slack_notification") {
    return ["slack", "notification", "status"];
  }

  if (capabilityId === "email_delivery") {
    return ["email", "mail"];
  }

  if (capabilityId === "payment_flow") {
    return ["payment", "stripe", "checkout"];
  }

  if (capabilityId === "database_write") {
    return ["database", "db", "persist", "write"];
  }

  return [capabilityId];
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function toolEdgeFromMatchingTool(
  context: IntentContext,
  kind: EdgeKind,
  toolMatcher: (text: string, node: GraphNode) => boolean,
  toMatcher: (text: string, node: GraphNode) => boolean
): RequirementMatch {
  const nodeById = new Map(context.nodes.map((node) => [node.id, node]));
  const edges = context.edges.filter((edge) => {
    if (edge.kind !== kind) {
      return false;
    }

    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);

    return Boolean(
      from &&
      from.kind === "tool" &&
      toolMatcher(nodeText(from), from) &&
      to &&
      toMatcher(nodeText(to), to)
    );
  });

  return {
    edgeIds: edges.map((edge) => edge.id),
    evidence: edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`)
  };
}

function companionEdgeForMatchingTool(
  context: IntentContext,
  kinds: EdgeKind[],
  toolMatcher: (text: string, node: GraphNode) => boolean,
  companionMatcher: (text: string, node: GraphNode) => boolean
): RequirementMatch {
  const nodeById = new Map(context.nodes.map((node) => [node.id, node]));
  const edges = context.edges.filter((edge) => {
    if (!kinds.includes(edge.kind)) {
      return false;
    }

    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    const fromText = from ? nodeText(from) : "";
    const toText = to ? nodeText(to) : "";

    return Boolean(
      from &&
      to &&
      ((from.kind === "tool" &&
        toolMatcher(fromText, from) &&
        companionMatcher(toText, to)) ||
        (to.kind === "tool" &&
          toolMatcher(toText, to) &&
          companionMatcher(fromText, from)))
    );
  });

  return {
    edgeIds: edges.map((edge) => edge.id),
    evidence: edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`)
  };
}

const issueToolMatcher = (text: string) => includesAny(text, ["issue", "ticket", "github"]);
const slackToolMatcher = (text: string) => includesAny(text, ["slack", "notification", "status"]);
const emailToolMatcher = (text: string) => includesAny(text, ["email", "mail"]);
const paymentToolMatcher = (text: string) => includesAny(text, ["payment", "stripe", "checkout"]);

const capabilityDefinitions: CapabilityDefinition[] = [
  {
    id: "issue_creation",
    label: "issue creation",
    terms: [/\bissue\b/, /\bticket\b/, /\bgithub\b/],
    requirements: [
      {
        id: "tool",
        kind: "tool",
        label: "Issue tool exists",
        repairHint: "Add or expose a tool whose name and metadata clearly represent issue creation.",
        evaluate: (context) => nodeMatch(context, "tool", issueToolMatcher)
      },
      {
        id: "schema",
        kind: "validates",
        label: "Issue tool validates input",
        repairHint: "Attach an input schema to the issue creation tool.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "validates", issueToolMatcher, (text, node) => node.kind === "schema" && text.includes("issue"))
      },
      {
        id: "external",
        kind: "calls",
        label: "Issue tool reaches an issue provider",
        repairHint: "Connect the issue tool to the intended issue provider API.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "calls", issueToolMatcher, (text, node) => node.kind === "external" && includesAny(text, ["github", "issue", "ticket", "linear", "jira"]))
      },
      {
        id: "secret",
        kind: "uses_secret",
        label: "Issue provider credential is explicit",
        repairHint: "Read the provider credential through an environment variable and keep it server-side.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "uses_secret", issueToolMatcher, (text, node) => node.kind === "env" && includesAny(text, ["github", "issue", "ticket", "token", "api_key"]))
      },
      ...externalToolCompanionRequirements("issue", issueToolMatcher)
    ]
  },
  {
    id: "slack_notification",
    label: "Slack notification",
    terms: [/\bslack\b/, /\bnotification\b/, /\bnotify\b/, /\bstatus\b/],
    requirements: [
      {
        id: "tool",
        kind: "tool",
        label: "Slack notification tool exists",
        repairHint: "Add or expose a tool for posting Slack/status notifications.",
        evaluate: (context) => nodeMatch(context, "tool", slackToolMatcher)
      },
      {
        id: "schema",
        kind: "validates",
        label: "Slack tool validates input",
        repairHint: "Attach an input schema to the Slack/status notification tool.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "validates", slackToolMatcher, (_text, node) => node.kind === "schema")
      },
      {
        id: "external",
        kind: "calls",
        label: "Slack tool reaches Slack",
        repairHint: "Connect the Slack notification tool to Slack or a configured webhook provider.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "calls", slackToolMatcher, (text, node) => node.kind === "external" && text.includes("slack"))
      },
      ...externalToolCompanionRequirements("slack", slackToolMatcher)
    ]
  },
  {
    id: "email_delivery",
    label: "email delivery",
    terms: [/\bemail\b/, /\bmail\b/],
    requirements: [
      {
        id: "tool",
        kind: "tool",
        label: "Email tool exists",
        repairHint: "Add or expose a tool for sending email.",
        evaluate: (context) => nodeMatch(context, "tool", emailToolMatcher)
      },
      {
        id: "external",
        kind: "calls",
        label: "Email tool reaches a mail provider",
        repairHint: "Connect the email tool to the configured mail provider.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "calls", emailToolMatcher, (text, node) => node.kind === "external" && includesAny(text, ["mail", "email", "sendgrid", "resend", "postmark"]))
      },
      ...externalToolCompanionRequirements("email", emailToolMatcher)
    ]
  },
  {
    id: "payment_flow",
    label: "payment flow",
    terms: [/\bpayment\b/, /\bcheckout\b/, /\bstripe\b/, /\bbilling\b/],
    requirements: [
      {
        id: "tool",
        kind: "tool",
        label: "Payment tool exists",
        repairHint: "Add or expose a payment/checkout tool.",
        evaluate: (context) => nodeMatch(context, "tool", paymentToolMatcher)
      },
      {
        id: "external",
        kind: "calls",
        label: "Payment tool reaches a payment provider",
        repairHint: "Connect the payment flow to Stripe or the configured payment provider.",
        evaluate: (context) =>
          toolEdgeFromMatchingTool(context, "calls", paymentToolMatcher, (text, node) => node.kind === "external" && includesAny(text, ["stripe", "payment", "checkout"]))
      },
      ...externalToolCompanionRequirements("payment", paymentToolMatcher)
    ]
  },
  {
    id: "database_write",
    label: "database write",
    terms: [/\bdatabase\b/, /\bdb\b/, /\bpersist\b/, /\bstor(e|ing)\b/, /\bwrite\b/],
    requirements: [
      {
        id: "write",
        kind: "writes",
        label: "A database write is present",
        repairHint: "Persist the intended data through the configured database client.",
        evaluate: (context) => edgeMatch(context, "writes", (edge) => edge.to.startsWith("database:"))
      },
      {
        id: "test",
        kind: "test",
        label: "Database behavior has test coverage",
        repairHint: "Add a test that proves the database write path succeeds and rejects invalid input.",
        evaluate: (context) => nodeMatch(context, "test", (text) => includesAny(text, ["database", "db", "persist", "write"]))
      }
    ]
  }
];

function externalToolCompanionRequirements(
  subject: string,
  toolMatcher: (text: string, node: GraphNode) => boolean
): RequirementDefinition[] {
  return [
    {
      id: "audit",
      kind: "service",
      label: "External call has audit logging",
      repairHint: `Add audit logging around the ${subject} external call.`,
      evaluate: (context) =>
        companionEdgeForMatchingTool(
          context,
          ["calls", "writes"],
          toolMatcher,
          (text, node) => node.kind === "service" && includesAny(text, ["audit", "log"])
        )
    },
    {
      id: "redaction",
      kind: "service",
      label: "External call has a redaction boundary",
      repairHint: `Redact sensitive ${subject} inputs and provider errors before audit logs or agent-visible output.`,
      evaluate: (context) =>
        companionEdgeForMatchingTool(
          context,
          ["calls", "writes"],
          toolMatcher,
          (text, node) => node.kind === "service" && includesAny(text, ["redact", "secret"])
        )
    },
    {
      id: "permission",
      kind: "contract",
      label: "External capability has a permission contract",
      repairHint: `Require a scoped permission grant before the ${subject} tool can call an external provider.`,
      evaluate: (context) =>
        companionEdgeForMatchingTool(
          context,
          ["satisfies"],
          toolMatcher,
          (text, node) => node.kind === "contract" && includesAny(text, ["permission", "scope", subject])
        )
    },
    {
      id: "unauthorized_test",
      kind: "test",
      label: "Unauthorized external calls are tested",
      repairHint: `Add a test that calls the ${subject} tool without permission and asserts no external request is made.`,
      evaluate: (context) => {
        const tests = nodeMatch(
          context,
          "test",
          (text) => text.includes("unauthorized") && text.includes(subject)
        );

        if (tests.nodeIds && tests.nodeIds.length > 0) {
          return tests;
        }

        return edgeMatch(context, "covers", (edge) => {
          const nodeById = new Map(context.nodes.map((node) => [node.id, node]));
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);

          return Boolean(
            from &&
            from.kind === "test" &&
            nodeText(from).includes("unauthorized") &&
            to &&
            to.kind === "tool" &&
            toolMatcher(nodeText(to), to)
          );
        });
      }
    }
  ];
}
