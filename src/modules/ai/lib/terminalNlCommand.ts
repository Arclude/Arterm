import { generateText } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildConfiguredLanguageModel } from "./agent";
import { useChatStore } from "../store/chatStore";

// One-shot natural-language → shell-command generation for the terminal
// Ctrl+K affordance. Deliberately bypasses the chat pipeline: no tools, no
// history, no system persona — a single low-temperature completion that must
// return nothing but the command. The command is only ever INSERTED into the
// prompt, never executed; the user reviews and presses Enter themselves.

export type NlCommandContext = {
  /** Shell kind label ("pwsh", "bash", …) or null when unknown. */
  shell: string | null;
  cwd: string | null;
  /** OS hint, e.g. "windows" | "macos" | "linux". */
  os: string;
  /**
   * Tail of the terminal buffer so requests like "retry that with sudo"
   * resolve. Callers must pass null for private terminals.
   */
  recentOutput: string | null;
};

function detectOs(): string {
  const p = navigator.userAgent.toLowerCase();
  if (p.includes("windows")) return "windows";
  if (p.includes("mac")) return "macos";
  return "linux";
}

function buildSystem(ctx: NlCommandContext): string {
  const shell = ctx.shell ?? (ctx.os === "windows" ? "powershell" : "bash");
  const lines = [
    `You convert a natural-language request into ONE ${shell} command for ${ctx.os}.`,
    "Rules:",
    "- Reply with ONLY the raw command — no explanation, no markdown, no code fences, no leading `$` or `>`.",
    "- Use syntax valid for this exact shell. PowerShell and POSIX shells differ; do not mix them.",
    "- Prefer a single line. Chain steps with the shell's correct operator when needed.",
    "- If the request references previous output, use the terminal context below.",
    "- If the request cannot be expressed as a command, reply with exactly: ERROR: <short reason>",
  ];
  if (ctx.cwd) lines.push(`\nCurrent directory: ${ctx.cwd}`);
  if (ctx.recentOutput?.trim()) {
    lines.push(`\nRecent terminal output:\n${ctx.recentOutput}`);
  }
  return lines.join("\n");
}

/**
 * Pull the command out of a model reply. Tolerates the common failure modes
 * (fenced block, `$ ` prefix) but otherwise trusts the prompt contract.
 */
function extractCommand(raw: string): string {
  let t = raw.trim();
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^\$\s+/, "").replace(/^>\s+/, "");
  // Strip dangerous control bytes from the model reply before it is inserted
  // into the PTY. The text is pasted (not executed) but a raw ESC/BEL/etc.
  // could drive terminal escape sequences; tab and newline are preserved
  // (newlines are bracketed-paste-wrapped by the caller, so they cannot
  // auto-submit).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return t.trim();
}

export async function generateShellCommand(
  request: string,
  ctx: Omit<NlCommandContext, "os">,
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
  const full: NlCommandContext = { ...ctx, os: detectOs() };
  const { text } = await generateText({
    model,
    system: buildSystem(full),
    prompt: request,
    temperature: 0,
    maxOutputTokens: 400,
    abortSignal: signal,
  });
  const cmd = extractCommand(text);
  if (!cmd) throw new Error("The model returned an empty command.");
  if (cmd.startsWith("ERROR:")) {
    throw new Error(cmd.slice("ERROR:".length).trim() || "Not a command.");
  }
  return cmd;
}
