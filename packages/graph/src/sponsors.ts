import { diffGraph } from "./diff";
import type { GraphDiff, ReplaySnapshot, SnitchWarning } from "./types";

export type CerebrasMessage = {
  role: "system" | "user";
  content: string;
};

export type CerebrasNarrationInput = {
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

export function createStaticNarration(diff: GraphDiff, warnings: SnitchWarning[]): string {
  const warningText =
    warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"} need review.`
      : "No active warnings.";

  return `Snitch saw ${diff.summary.addedNodes} added node${diff.summary.addedNodes === 1 ? "" : "s"}, ${diff.summary.changedNodes} changed node${diff.summary.changedNodes === 1 ? "" : "s"}, and ${diff.summary.addedEdges} added edge${diff.summary.addedEdges === 1 ? "" : "s"}. ${warningText}`;
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
        content: `Snitch warning decision: ${input.decision}\nWarning: ${input.warning.title}\nEvidence: ${input.warning.evidence.join("; ")}`,
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
  const parsed = JSON.parse(content) as {
    diffSummary?: GraphDiff["summary"];
    warnings?: SnitchWarning[];
  };

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

function extractRules(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toUpperCase().startsWith("RULE:"))
    .map((line) => line.slice(line.indexOf(":") + 1).trim())
    .filter(Boolean);
}
