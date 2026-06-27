import { describe, expect, it } from "vitest";
import {
  createCerebrasNarrationInput,
  createStaticNarration,
  diffGraph,
  getDemoReplay,
  getReviewSnapshot,
  loadBackboardRepoRules,
  narrateWithCerebras,
  rememberBackboardWarningDecision
} from "./index";

const replay = getDemoReplay();
const previous = replay[2];
const reviewSnapshot = getReviewSnapshot(replay);
const diff = diffGraph(previous.graph, reviewSnapshot.graph);

describe("Cerebras sponsor lane", () => {
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
});

describe("Backboard sponsor lane", () => {
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
