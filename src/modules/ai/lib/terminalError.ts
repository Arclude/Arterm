import { useChatStore } from "../store/chatStore";
import { redactSensitive } from "./redact";

export type TerminalErrorContext = {
  command: string | null;
  exitCode: number;
  cwd: string | null;
  shell: string;
  output: string;
};

const PREFIXES = {
  explain: "Explain why this terminal command failed and how to resolve it.",
  fix: "This terminal command failed. Reply with a corrected command in a fenced code block plus a one-line explanation. Do not run anything yet.",
} as const;

// Attribute values live inside double quotes; a '"' (legal in Unix paths,
// possible in command lines) would break out of the attribute, so swap it
// for "'" and collapse newlines.
function attrSafe(value: string): string {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

function buildBlock(ctx: TerminalErrorContext): string {
  const attrs = [
    `shell="${attrSafe(ctx.shell)}"`,
    `exit-code="${ctx.exitCode}"`,
  ];
  if (ctx.cwd !== null) attrs.push(`cwd="${attrSafe(ctx.cwd)}"`);
  if (ctx.command !== null) {
    const command = attrSafe(redactSensitive(ctx.command)).slice(0, 300);
    attrs.push(`command="${command}"`);
  }
  // Redact BEFORE truncating: a secret straddling the 4000-char boundary
  // would otherwise lose the leading anchor its pattern needs (env-var name,
  // sk-/Bearer/AKIA prefix) and its surviving tail would leak unredacted.
  const output = redactSensitive(ctx.output).slice(-4000);
  return `<terminal-error ${attrs.join(" ")}>\n${output}\n</terminal-error>`;
}

export function openTerminalErrorChat(
  mode: "explain" | "fix",
  ctx: TerminalErrorContext,
): void {
  const prefill = `${PREFIXES[mode]}\n\n${buildBlock(ctx)}`;
  useChatStore.getState().focusInput(prefill);
}
