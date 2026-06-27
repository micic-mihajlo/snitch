import { describe, expect, it } from "vitest";
import {
  createCerebrasNarrationInput,
  createCerebrasDiagramInput,
  createCerebrasWarningTriageInput,
  createFallbackWarningRankings,
  createStaticNarration,
  diagramWithCerebras,
  diffGraph,
  getDemoReplay,
  getReviewSnapshot,
  loadBackboardRepoRules,
  narrateWithCerebras,
  rankWarningsWithCerebras,
  rememberBackboardWarningDecision
} from "./index";

const replay = getDemoReplay();
const previous = replay[2];
const reviewSnapshot = getReviewSnapshot(replay);
const diff = diffGraph(previous.graph, reviewSnapshot.graph);

describe("Cerebras integration", () => {
  it("builds compact narration input from task, diff, warnings, and repo rules", () => {
    const input = createCerebrasNarrationInput({
      task: "Add the external issue-creation tool.",
      diff,
      warnings: reviewSnapshot.warnings,
      repoRules: ["External tools require audit logging."]
    });

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0].role).toBe("system");
    expect(input.messages[1].content).toContain("Add the external issue-creation tool.");
    expect(input.messages[1].content).toContain("\"addedNodes\"");
    expect(input.messages[1].content).toContain("No audit trail for external tool calls");
    expect(input.messages[1].content).toContain("External tools require audit logging.");
  });

  it("falls back to static narration when inference fails", async () => {
    const input = createCerebrasNarrationInput({
      task: "Add the external issue-creation tool.",
      diff,
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });

    const result = await narrateWithCerebras({
      apiKey: "test-key",
      model: "gpt-oss-120b",
      input,
      fetcher: async () => {
        throw new Error("network offline");
      }
    });

    expect(result.status).toBe("fallback");
    expect(result.text).toBe(createStaticNarration(diff, reviewSnapshot.warnings));
  });

  it("falls back instead of throwing when narration input is malformed", async () => {
    const result = await narrateWithCerebras({
      apiKey: "test-key",
      model: "gpt-oss-120b",
      input: {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "{not json" }
        ]
      },
      fetcher: async () => {
        throw new Error("network offline");
      }
    });

    expect(result).toEqual({
      status: "fallback",
      model: "gpt-oss-120b",
      text: "Snitch saw 0 added nodes, 0 changed nodes, and 0 added edges. No active warnings."
    });
  });

  it("reports disabled when no Cerebras key is present", async () => {
    const input = createCerebrasNarrationInput({
      task: "Add the external issue-creation tool.",
      diff,
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });

    await expect(narrateWithCerebras({ apiKey: "", model: "gpt-oss-120b", input })).resolves.toMatchObject({
      status: "disabled"
    });
  });

  it("uses a larger completion budget for GLM narration models", async () => {
    const input = createCerebrasNarrationInput({
      task: "Add the external issue-creation tool.",
      diff,
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });
    let requestedTokens = 0;
    const result = await narrateWithCerebras({
      apiKey: "test-key",
      model: "zai-glm-4.7",
      input,
      fetcher: async (_url, init) => {
        requestedTokens = JSON.parse(String(init?.body)).max_completion_tokens;

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Graph changed fast." } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    expect(result.status).toBe("ok");
    expect(requestedTokens).toBe(2000);
  });

  it("builds compact warning triage input for strict JSON ranking", () => {
    const input = createCerebrasWarningTriageInput({
      task: "Add the external issue-creation tool.",
      warnings: reviewSnapshot.warnings,
      repoRules: ["External tools require audit logging."]
    });

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0].content).toContain("Return strict JSON only");
    expect(input.messages[1].content).toContain("\"rankedWarnings\"");
    expect(input.messages[1].content).toContain("No audit trail for external tool calls");
  });

  it("uses Cerebras to create a validated compact diagram graph", async () => {
    const input = createCerebrasDiagramInput({
      task: "Add the external issue-creation tool.",
      graph: reviewSnapshot.graph,
      warnings: reviewSnapshot.warnings,
      repoRules: ["External tools require audit logging."],
      changedFiles: [{ path: "apps/demo-app/src/tools/create-issue.ts", status: "M" }]
    });
    const result = await diagramWithCerebras({
      apiKey: "test-key",
      model: "zai-glm-4.7",
      input,
      graph: reviewSnapshot.graph,
      warnings: reviewSnapshot.warnings,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Issue tool path",
                    summary: "The issue tool reaches GitHub without required safeguards.",
                    nodes: [
                      { id: "tool:create_issue", label: "Create issue" },
                      { id: "external:issue_provider", label: "Issue provider" },
                      { id: "warning:tool_audit_log_missing:create_issue", label: "Missing audit log" },
                      { id: "invented:node", label: "Drop me" }
                    ],
                    edges: [
                      { from: "tool:create_issue", to: "external:issue_provider", kind: "calls" },
                      { from: "tool:create_issue", to: "warning:tool_audit_log_missing:create_issue", kind: "missing" },
                      { from: "invented:node", to: "tool:create_issue", kind: "calls" }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    expect(result.status).toBe("ok");
    expect(result.model).toBe("zai-glm-4.7");
    expect(result.summary).toContain("GitHub");
    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      "tool:create_issue",
      "external:issue_provider",
      "warning:tool_audit_log_missing:create_issue"
    ]);
    expect(result.graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`)).toEqual([
      "tool:create_issue->external:issue_provider:calls",
      "tool:create_issue->warning:tool_audit_log_missing:create_issue:missing"
    ]);
  });

  it("falls back to a deterministic warning diagram when Cerebras diagramming fails", async () => {
    const input = createCerebrasDiagramInput({
      task: "Add the external issue-creation tool.",
      graph: reviewSnapshot.graph,
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });
    const result = await diagramWithCerebras({
      apiKey: "test-key",
      model: "gpt-oss-120b",
      input,
      graph: reviewSnapshot.graph,
      warnings: reviewSnapshot.warnings,
      fetcher: async () => {
        throw new Error("network offline");
      }
    });

    expect(result.status).toBe("fallback");
    expect(result.graph.nodes.some((node) => node.kind === "warning")).toBe(true);
    expect(result.summary).toContain("active warning");
  });

  it("parses Cerebras warning ranking JSON and fills missing warnings with fallback ranks", async () => {
    const input = createCerebrasWarningTriageInput({
      task: "Add the external issue-creation tool.",
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });
    const result = await rankWarningsWithCerebras({
      apiKey: "test-key",
      model: "gpt-oss-120b",
      input,
      warnings: reviewSnapshot.warnings,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rankedWarnings: [
                      {
                        warningId: "warning:permission_scope_missing:create_issue",
                        rank: 1,
                        priority: "critical",
                        reason: "Provider write is exposed without a scoped grant.",
                        repairPrompt: "Gate create_issue behind a session-scoped permission check."
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    expect(result.status).toBe("ok");
    expect(result.model).toBe("gpt-oss-120b");
    expect(result.rankedWarnings[0]).toEqual({
      warningId: "warning:permission_scope_missing:create_issue",
      rank: 1,
      priority: "critical",
      reason: "Provider write is exposed without a scoped grant.",
      repairPrompt: "Gate create_issue behind a session-scoped permission check."
    });
    expect(result.rankedWarnings).toHaveLength(reviewSnapshot.warnings.length);
  });

  it("uses a larger completion budget for GLM warning triage models", async () => {
    const input = createCerebrasWarningTriageInput({
      task: "Add the external issue-creation tool.",
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });
    let requestedTokens = 0;
    const result = await rankWarningsWithCerebras({
      apiKey: "test-key",
      model: "zai-glm-4.7",
      input,
      warnings: reviewSnapshot.warnings,
      fetcher: async (_url, init) => {
        requestedTokens = JSON.parse(String(init?.body)).max_completion_tokens;

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rankedWarnings: [
                      {
                        warningId: "warning:tool_audit_log_missing:create_issue",
                        rank: 1,
                        priority: "high",
                        reason: "Audit logging is still missing.",
                        repairPrompt: "Add audit logging around create_issue."
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    expect(result.status).toBe("ok");
    expect(requestedTokens).toBe(3000);
  });

  it("returns deterministic fallback rankings when warning triage is disabled", async () => {
    const input = createCerebrasWarningTriageInput({
      task: "Add the external issue-creation tool.",
      warnings: reviewSnapshot.warnings,
      repoRules: []
    });
    const result = await rankWarningsWithCerebras({
      apiKey: "",
      model: "gpt-oss-120b",
      input,
      warnings: reviewSnapshot.warnings
    });

    expect(result.status).toBe("disabled");
    expect(result.rankedWarnings).toEqual(createFallbackWarningRankings(reviewSnapshot.warnings));
    expect(result.rankedWarnings[0]?.warningId).toBe("warning:tool_audit_log_missing:create_issue");
  });
});

describe("Backboard integration", () => {
  it("turns memory response content into repo rules", async () => {
    const result = await loadBackboardRepoRules({
      apiKey: "test-key",
      assistantId: "assistant-1",
      task: "Add the external issue-creation tool.",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            content:
              "RULE: External tools require audit logging.\nRULE: Redact provider credentials before audit writes."
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    expect(result).toEqual({
      status: "ok",
      rules: [
        "External tools require audit logging.",
        "Redact provider credentials before audit writes."
      ]
    });
  });

  it("does not throw when Backboard credentials are absent", async () => {
    await expect(loadBackboardRepoRules({ apiKey: "", task: "x" })).resolves.toEqual({
      status: "disabled",
      rules: []
    });
  });

  it("records warning decisions through Backboard without sending raw evidence", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const warning = {
      ...reviewSnapshot.warnings[0],
      evidence: [
        "provider error includes secret SECRET_DO_NOT_SEND",
        "payload.path=/private/tmp/issue-body.json"
      ]
    };
    const result = await rememberBackboardWarningDecision({
      apiKey: "test-key",
      assistantId: "assistant-1",
      warning,
      decision: "accepted",
      fetcher: async (url, init) => {
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ content: "OK" }), { status: 200 });
      }
    });

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://app.backboard.io/api/threads/messages");
    expect(calls[0]?.body).toContain("accepted");
    expect(calls[0]?.body).toContain("No audit trail for external tool calls");
    expect(calls[0]?.body).toContain("evidenceHashes");
    expect(calls[0]?.body).not.toContain("SECRET_DO_NOT_SEND");
    expect(calls[0]?.body).not.toContain("/private/tmp/issue-body.json");
  });
});
