import { diffGraph, hashEvidence } from "./diff";
import type { GraphDiff, ReplaySnapshot, SnitchWarning } from "./types";

export type CerebrasMessage = {
  role: "system" | "user";
  content: string;
};

export type CerebrasNarrationInput = {
  messages: CerebrasMessage[];
};

export type CerebrasWarningTriageInput = {
  messages: CerebrasMessage[];
};

export type CerebrasNarrationOptions = {
  apiKey?: string;
  model: string;
  input: CerebrasNarrationInput;
  fetcher?: typeof fetch;
};

export type SponsorResultStatus = "ok" | "disabled" | "fallback";

export type CerebrasNarrationResult = {
  status: SponsorResultStatus;
  text: string;
  model?: string;
};

export type WarningPriority = "critical" | "high" | "medium" | "low";

export type RankedWarning = {
  warningId: string;
  rank: number;
  priority: WarningPriority;
  reason: string;
  repairPrompt: string;
};

export type CerebrasWarningTriageResult = {
  status: SponsorResultStatus;
  rankedWarnings: RankedWarning[];
  model?: string;
};

export type BackboardRuleResult = {
  status: SponsorResultStatus;
  rules: string[];
};

export type BackboardDecisionResult = {
  status: SponsorResultStatus;
};

export function createCerebrasNarrationInput(input: {
  task: string;
  diff: GraphDiff;
  warnings: SnitchWarning[];
  repoRules: string[];
}): CerebrasNarrationInput {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are Snitch's fast semantic lane. Explain graph diffs tersely. Do not invent graph facts."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.task,
            diffSummary: input.diff.summary,
            addedNodes: input.diff.addedNodes.map((node) => ({ id: node.id, label: node.label })),
            changedNodes: input.diff.changedNodes.map((change) => ({
              id: change.id,
              previousHash: change.previous.hash,
              nextHash: change.next.hash
            })),
            warnings: input.warnings.map((warning) => ({
              id: warning.id,
              title: warning.title,
              severity: warning.severity,
              evidence: warning.evidence
            })),
            repoRules: input.repoRules
          },
          null,
          2
        )
      }
    ]
  };
}

export function createCerebrasWarningTriageInput(input: {
  task: string;
  warnings: SnitchWarning[];
  repoRules: string[];
}): CerebrasWarningTriageInput {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are Snitch's warning triage lane. Rank warnings for developer action. Return strict JSON only."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.task,
            expectedShape: {
              rankedWarnings: [
                {
                  warningId: "string",
                  rank: 1,
                  priority: "critical | high | medium | low",
                  reason: "short reason grounded in warning evidence",
                  repairPrompt: "one concrete repair instruction"
                }
              ]
            },
            warnings: input.warnings.map((warning) => ({
              id: warning.id,
              title: warning.title,
              severity: warning.severity,
              message: warning.message,
              evidence: warning.evidence,
              repairPrompt: warning.repairPrompt
            })),
            repoRules: input.repoRules
          },
          null,
          2
        )
      }
    ]
  };
}

export async function narrateWithCerebras(
  options: CerebrasNarrationOptions
): Promise<CerebrasNarrationResult> {
  if (!options.apiKey?.trim()) {
    return {
      status: "disabled",
      text: "Cerebras is not configured, so Snitch is using static narration."
    };
  }

  const fallbackText = createStaticNarrationFromInput(options.input);

  try {
    const response = await (options.fetcher ?? fetch)("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.input.messages,
        max_completion_tokens: 180,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Cerebras responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new Error("Cerebras returned an empty completion");
    }

    return {
      status: "ok",
      text,
      model: options.model
    };
  } catch {
    return {
      status: "fallback",
      text: fallbackText,
      model: options.model
    };
  }
}

export async function rankWarningsWithCerebras(options: {
  apiKey?: string;
  model: string;
  input: CerebrasWarningTriageInput;
  warnings: SnitchWarning[];
  fetcher?: typeof fetch;
}): Promise<CerebrasWarningTriageResult> {
  const fallbackRankings = createFallbackWarningRankings(options.warnings);

  if (!options.apiKey?.trim()) {
    return {
      status: "disabled",
      rankedWarnings: fallbackRankings
    };
  }

  try {
    const response = await (options.fetcher ?? fetch)("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.input.messages,
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`Cerebras responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const rankedWarnings = parseRankedWarnings(content, options.warnings);

    if (rankedWarnings.length === 0 && options.warnings.length > 0) {
      throw new Error("Cerebras returned no ranked warnings");
    }

    return {
      status: "ok",
      rankedWarnings,
      model: options.model
    };
  } catch {
    return {
      status: "fallback",
      rankedWarnings: fallbackRankings,
      model: options.model
    };
  }
}

export function createStaticNarration(diff: GraphDiff, warnings: SnitchWarning[]): string {
  const warningText =
    warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"} need review.`
      : "No active warnings.";

  return `Snitch saw ${diff.summary.addedNodes} added node${diff.summary.addedNodes === 1 ? "" : "s"}, ${diff.summary.changedNodes} changed node${diff.summary.changedNodes === 1 ? "" : "s"}, and ${diff.summary.addedEdges} added edge${diff.summary.addedEdges === 1 ? "" : "s"}. ${warningText}`;
}

export function createFallbackWarningRankings(warnings: SnitchWarning[]): RankedWarning[] {
  const severityWeight: Record<SnitchWarning["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3
  };

  return [...warnings]
    .sort((left, right) => severityWeight[left.severity] - severityWeight[right.severity])
    .map((warning, index) => ({
      warningId: warning.id,
      rank: index + 1,
      priority: severityToPriority(warning.severity),
      reason: warning.message,
      repairPrompt: warning.repairPrompt ?? `Repair ${warning.title}.`
    }));
}

export async function loadBackboardRepoRules(input: {
  apiKey?: string;
  assistantId?: string;
  task: string;
  fetcher?: typeof fetch;
}): Promise<BackboardRuleResult> {
  if (!input.apiKey?.trim()) {
    return { status: "disabled", rules: [] };
  }

  try {
    const response = await (input.fetcher ?? fetch)("https://app.backboard.io/api/threads/messages", {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: `Return repo rules relevant to this Snitch task. Prefix each rule with RULE:. Task: ${input.task}`,
        stream: false,
        memory: "Readonly",
        ...(input.assistantId ? { assistant_id: input.assistantId } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Backboard responded with ${response.status}`);
    }

    const payload = (await response.json()) as { content?: string; message?: string };
    return {
      status: "ok",
      rules: extractRules(payload.content ?? payload.message ?? "")
    };
  } catch {
    return { status: "fallback", rules: [] };
  }
}

export async function rememberBackboardWarningDecision(input: {
  apiKey?: string;
  assistantId?: string;
  warning: SnitchWarning;
  decision: "accepted" | "dismissed" | "repaired";
  fetcher?: typeof fetch;
}): Promise<BackboardDecisionResult> {
  if (!input.apiKey?.trim()) {
    return { status: "disabled" };
  }

  try {
    const response = await (input.fetcher ?? fetch)("https://app.backboard.io/api/threads/messages", {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({
          type: "snitch_warning_decision",
          decision: input.decision,
          warningId: input.warning.id,
          severity: input.warning.severity,
          title: input.warning.title,
          evidenceHashes: input.warning.evidence.map((evidence) => hashEvidence(evidence))
        }),
        stream: false,
        memory: "Auto",
        ...(input.assistantId ? { assistant_id: input.assistantId } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Backboard responded with ${response.status}`);
    }

    return { status: "ok" };
  } catch {
    return { status: "fallback" };
  }
}

export function createNarrationForSnapshot(input: {
  previous: ReplaySnapshot;
  next: ReplaySnapshot;
  task: string;
  repoRules: string[];
}): CerebrasNarrationInput {
  return createCerebrasNarrationInput({
    task: input.task,
    diff: diffGraph(input.previous.graph, input.next.graph),
    warnings: input.next.warnings,
    repoRules: input.repoRules
  });
}

function createStaticNarrationFromInput(input: CerebrasNarrationInput): string {
  const content = input.messages.find((message) => message.role === "user")?.content ?? "{}";
  const parsed = parseNarrationInput(content);

  return createStaticNarration(
    {
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
      unchangedNodes: [],
      addedEdges: [],
      removedEdges: [],
      changedEdges: [],
      unchangedEdges: [],
      summary: parsed.diffSummary ?? {
        addedNodes: 0,
        removedNodes: 0,
        changedNodes: 0,
        addedEdges: 0,
        removedEdges: 0,
        changedEdges: 0
      }
    },
    parsed.warnings ?? []
  );
}

function parseNarrationInput(content: string): {
  diffSummary?: GraphDiff["summary"];
  warnings?: SnitchWarning[];
} {
  try {
    return JSON.parse(content) as {
      diffSummary?: GraphDiff["summary"];
      warnings?: SnitchWarning[];
    };
  } catch {
    return {};
  }
}

function parseRankedWarnings(content: string | undefined, warnings: SnitchWarning[]): RankedWarning[] {
  if (!content) {
    return [];
  }

  const warningIds = new Set(warnings.map((warning) => warning.id));
  const fallbackById = new Map(createFallbackWarningRankings(warnings).map((ranking) => [ranking.warningId, ranking]));
  const parsed = parseJsonObject(extractJson(content)) as {
    rankedWarnings?: Array<Partial<RankedWarning>>;
  };
  const rankedWarnings = Array.isArray(parsed.rankedWarnings) ? parsed.rankedWarnings : [];
  const result: RankedWarning[] = [];
  const seen = new Set<string>();

  for (const item of rankedWarnings) {
    if (typeof item.warningId !== "string" || !warningIds.has(item.warningId) || seen.has(item.warningId)) {
      continue;
    }

    const fallback = fallbackById.get(item.warningId);
    const rank = typeof item.rank === "number" && Number.isFinite(item.rank) ? item.rank : result.length + 1;
    const priority = isWarningPriority(item.priority) ? item.priority : fallback?.priority ?? "medium";
    const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : fallback?.reason ?? "";
    const repairPrompt =
      typeof item.repairPrompt === "string" && item.repairPrompt.trim()
        ? item.repairPrompt.trim()
        : fallback?.repairPrompt ?? "";

    result.push({
      warningId: item.warningId,
      rank,
      priority,
      reason,
      repairPrompt
    });
    seen.add(item.warningId);
  }

  for (const fallback of fallbackById.values()) {
    if (!seen.has(fallback.warningId)) {
      result.push({
        ...fallback,
        rank: result.length + 1
      });
    }
  }

  return result.sort((left, right) => left.rank - right.rank);
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() ?? content.trim();
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return {};
  }
}

function severityToPriority(severity: SnitchWarning["severity"]): WarningPriority {
  if (severity === "high") {
    return "high";
  }

  if (severity === "medium") {
    return "medium";
  }

  return "low";
}

function isWarningPriority(value: unknown): value is WarningPriority {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function extractRules(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toUpperCase().startsWith("RULE:"))
    .map((line) => line.slice(line.indexOf(":") + 1).trim())
    .filter(Boolean);
}
