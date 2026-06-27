import { describe, expect, it } from "vitest";
import { inferPhase, normalizeSnitchEvent, summarizePayload } from "./index";

describe("snitch events", () => {
  it("normalizes hook payloads without storing unsafe raw command text", () => {
    const event = normalizeSnitchEvent({
      runId: "run-1",
      source: "codex",
      hook: "PostToolUse",
      receivedAt: new Date("2026-06-27T12:00:00.000Z"),
      stdin: JSON.stringify({
        tool_name: "apply_patch",
        file_path: "src/tools/issues.ts",
        line: 42,
        command: "private-value should not be persisted",
        unsafe_value: "private-value"
      })
    });

    const serialized = JSON.stringify(event);

    expect(event.source).toBe("codex");
    expect(event.phase).toBe("tool_after");
    expect(event.safeSummary.tool_name).toBe("apply_patch");
    expect(event.safeSummary.file_path).toBe("src/tools/issues.ts");
    expect(event.safeSummary.commandHash).toEqual(expect.any(String));
    expect(event.evidence).toEqual([{ file: "src/tools/issues.ts", line: 42 }]);
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("should not be persisted");
  });

  it("keeps non-json payload summaries bounded and hashable", () => {
    const summary = summarizePayload("plain hook output");

    expect(summary).toEqual({ kind: "text", bytes: 17 });
  });

  it("maps common agent hooks to trace phases", () => {
    expect(inferPhase("SessionStart")).toBe("session_start");
    expect(inferPhase("PreToolUse")).toBe("tool_before");
    expect(inferPhase("tool.execute.after")).toBe("tool_after");
    expect(inferPhase("file.edited")).toBe("file_changed");
    expect(inferPhase("Stop")).toBe("session_stop");
  });
});
