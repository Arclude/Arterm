import { generateText } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "../store/chatStore";
import { buildConfiguredLanguageModel } from "./agent";

// One-shot AI edit of an editor selection for the Ctrl+K affordance.
// Mirrors terminalNlCommand: bypasses the chat pipeline (no tools, no history,
// no persona) — a single low-temperature completion that returns ONLY the
// rewritten code. The result is shown as an inline diff for the user to
// accept or discard; it is never applied silently.

export type InlineEditContext = {
  /** Human language label, e.g. "TypeScript". */
  language: string;
  /** File path, used only as a weak hint to the model. */
  path: string;
};

function buildSystem(ctx: InlineEditContext): string {
  return [
    `You are an expert code-editing assistant. You receive a snippet of ${ctx.language} code and an instruction, and rewrite the snippet to satisfy it.`,
    "Rules:",
    "- Reply with ONLY the rewritten code — no explanation, no commentary, no markdown code fences.",
    "- Return a drop-in replacement for the given snippet: keep the original indentation level and code style.",
    "- Make the minimal change needed for the instruction; do not reformat or touch unrelated code.",
    "- Preserve trailing/leading blank structure of the snippet where it makes sense.",
    "- If the instruction cannot be applied to this code, reply with exactly: ERROR: <short reason>",
  ].join("\n");
}

/** Pull the code out of a model reply, tolerating the common fenced-block case. */
function extractCode(raw: string): string {
  let t = raw.replace(/^\n+/, "").replace(/\n+$/, "");
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1];
  return t;
}

export async function generateInlineEdit(
  code: string,
  instruction: string,
  ctx: InlineEditContext,
  signal?: AbortSignal,
): Promise<string> {
  const prefs = usePreferencesStore.getState();
  const chat = useChatStore.getState();
  const model = await buildConfiguredLanguageModel(
    chat.selectedModelId,
    chat.apiKeys,
    {
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      lmstudioModelId: prefs.lmstudioModelId,
      mlxBaseURL: prefs.mlxBaseURL,
      mlxModelId: prefs.mlxModelId,
      ollamaBaseURL: prefs.ollamaBaseURL,
      ollamaModelId: prefs.ollamaModelId,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
      openaiCompatibleModelId: prefs.openaiCompatibleModelId,
      openrouterModelId: prefs.openrouterModelId,
      customEndpoints: prefs.customEndpoints,
      customEndpointKeys: chat.customEndpointKeys,
    },
  );
  const { text } = await generateText({
    model,
    system: buildSystem(ctx),
    prompt: `Instruction: ${instruction}\n\nCode:\n${code}`,
    temperature: 0,
    maxOutputTokens: 4000,
    abortSignal: signal,
  });
  const out = extractCode(text);
  if (!out.trim()) throw new Error("The model returned an empty edit.");
  if (out.startsWith("ERROR:")) {
    throw new Error(out.slice("ERROR:".length).trim() || "Cannot edit.");
  }
  return out;
}
