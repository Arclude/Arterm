import { describe, expect, it } from "vitest";
import type { StampedEvent } from "../types";
import { buildTranscript } from "./transcript";

function ev(
  seq: number,
  type: string,
  extra: Record<string, unknown> = {},
): StampedEvent {
  return { seq, ts: seq * 1000, type, ...extra };
}

// assistant_message carries its prose nested as `message.content` (Message).
function asst(content: string): Record<string, unknown> {
  return { message: { role: "assistant", content } };
}

describe("buildTranscript", () => {
  it("groups an assistant message with its tool calls and results into one turn", () => {
    const turns = buildTranscript([
      ev(1, "assistant_message", asst("I'll read the file.")),
      ev(2, "tool_call", { name: "read", id: "c1", args: { path: "a.ts" } }),
      ev(3, "tool_result", {
        callId: "c1",
        name: "read",
        output: "file contents",
        isError: false,
      }),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t?.memberId).toBe("main");
    expect(t?.text).toBe("I'll read the file."); // from message.content
    expect(t?.tools).toHaveLength(1);
    expect(t?.tools[0]?.name).toBe("read");
    expect(t?.tools[0]?.args).toContain("a.ts");
    expect(t?.tools[0]?.output).toBe("file contents");
  });

  it("starts a new turn on each assistant message", () => {
    const turns = buildTranscript([
      ev(1, "assistant_message", asst("first")),
      ev(2, "tool_call", { name: "ls", id: "c1" }),
      ev(3, "assistant_message", asst("second")),
    ]);
    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[1]?.tools).toHaveLength(0);
  });

  it("attaches a tool_result DiffRow[] + path and matches by callId", () => {
    const diff = [
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "add", new: 3, text: "new line" },
    ];
    const turns = buildTranscript([
      ev(1, "assistant_message", asst("edit")),
      ev(2, "tool_call", { name: "edit", id: "c1" }),
      ev(3, "tool_call", { name: "write", id: "c2" }),
      ev(4, "tool_result", { callId: "c1", name: "edit", diff, path: "a.ts" }),
    ]);
    const tools = turns[0]?.tools ?? [];
    expect(tools[0]?.name).toBe("edit");
    expect(tools[0]?.diff).toEqual(diff); // matched to c1, not the later c2
    expect(tools[0]?.path).toBe("a.ts");
    expect(tools[1]?.output).toBeUndefined();
  });

  it("attributes team_member_event to the member and unwraps the inner event", () => {
    const turns = buildTranscript([
      ev(1, "assistant_message", asst("main speaking")),
      ev(2, "team_member_event", {
        id: "m1",
        event: { type: "assistant_message", ...asst("member speaking") },
      }),
      ev(3, "team_member_event", {
        id: "m1",
        event: { type: "tool_call", name: "grep", id: "g1" },
      }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.memberId).toBe("main");
    expect(turns[1]?.memberId).toBe("m1");
    expect(turns[1]?.text).toBe("member speaking");
    expect(turns[1]?.tools[0]?.name).toBe("grep");
  });

  it("marks denied tools and errors, and ignores unrelated event types", () => {
    const turns = buildTranscript([
      ev(1, "assistant_message", asst("go")),
      ev(2, "tool_denied", { name: "bash" }),
      ev(3, "usage", { promptTokens: 10 }), // ignored
      ev(4, "error", { message: "boom" }),
      ev(5, "team_plan", { members: [] }), // ignored
    ]);
    expect(turns).toHaveLength(1);
    const tools = turns[0]?.tools ?? [];
    expect(tools.find((t) => t.name === "bash")?.denied).toBe(true);
    expect(tools.find((t) => t.name === "error")?.isError).toBe(true);
  });

  it("creates a bare turn when tools arrive before any message", () => {
    const turns = buildTranscript([
      ev(1, "tool_call", { name: "read", id: "c1" }),
      ev(2, "tool_result", { callId: "c1", output: "ok" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBeUndefined();
    expect(turns[0]?.tools[0]?.output).toBe("ok");
  });
});
