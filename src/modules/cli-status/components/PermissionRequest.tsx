import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getCliClient } from "../clientRegistry";
import type { PendingPermission, PermissionAnswer } from "../types";

const btn =
  "cli-mono inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:border-[color:var(--cli-accent)] hover:text-[color:var(--cli-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40 disabled:opacity-50";

/** Colour a preview line by its diff marker, mirroring the TUI prompt. */
function previewLineColor(line: string): string {
  const c = line[0];
  if (c === "+") return "var(--cli-run)";
  if (c === "-") return "var(--cli-fail)";
  if (c === "@" || c === "…") return "var(--cli-accent)";
  return "var(--cli-idle)";
}

/**
 * The permission prompt the CLI is blocked on, answerable from here (contract
 * §8). Without this the prompt can only be answered by typing in the terminal —
 * so an agent running in a background tab stalls unseen until you go find it.
 *
 * Whoever answers first wins: if the user answers in the terminal instead, the
 * request disappears from the snapshot and this card unmounts on its own.
 *
 * LAYOUT: the bar is a FIXED height and the preview body is an overlay hung
 * below it, never an in-flow block. A prompt arrives (and resolves) at whatever
 * moment the agent reaches the tool call, and the session pane is a flex column
 * whose only elastic child is the topology graph — so an in-flow card would
 * collapse the graph by its own height and make the whole centre jump ~300px
 * out from under the pointer, at the exact moment the user is reaching for
 * Allow/Deny. Keep every change here layout-neutral.
 */
export function PermissionRequest({
  sessionId,
  pending,
  queued = 0,
  originColor,
}: {
  sessionId: string;
  pending: PendingPermission;
  /** Requests waiting behind this one (sub-agents share one prompt queue). */
  queued?: number;
  /**
   * Palette colour of the topology node that raised this, from
   * {@link originColorVar}. Null when nothing on the graph corresponds to it.
   */
  originColor?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  // A destructive tool takes two clicks to approve, like the Stop control.
  const [confirming, setConfirming] = useState(false);
  const destructive = pending.riskTier === "destructive";
  // A destructive call opens its preview unprompted — you should not have to ask
  // to see what you are about to let `rm -rf` do.
  const [showPreview, setShowPreview] = useState(destructive);

  // A new request must never inherit the previous one's confirm state: the card
  // stays mounted while the queue advances from one request to the next.
  useEffect(() => {
    setConfirming(false);
    setShowPreview(pending.riskTier === "destructive");
  }, [pending.id, pending.riskTier]);

  const answer = async (value: PermissionAnswer) => {
    const client = getCliClient(sessionId);
    if (!client) {
      toast.error("Session is not connected");
      return;
    }
    setBusy(true);
    try {
      const res = await client.control("permission", {
        id: pending.id,
        answer: value,
      });
      if (!res.ok) {
        // The usual cause is a race: it was just answered in the terminal.
        toast.error(res.error ?? "The prompt could not be answered");
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const [head = pending.tool, ...body] = pending.preview.split("\n");
  const open = showPreview && body.length > 0;

  return (
    // `z-30` lifts the whole prompt — bar and overlay — above the topology graph
    // that the overlay hangs over. `shrink-0` + a fixed row height keep the
    // pane's other rows exactly where they were before the prompt arrived.
    <div
      className="relative z-30 shrink-0 border-b"
      style={{
        borderColor: "color-mix(in oklab, var(--cli-await) 45%, transparent)",
        background: "color-mix(in oklab, var(--cli-await) 8%, transparent)",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setShowPreview(false);
        }
      }}
    >
      <div className="flex h-11 items-center gap-2 px-4">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0"
          style={{ color: "var(--cli-await)" }}
        />
        <span
          className="cli-mono shrink-0 text-[11.5px] font-semibold"
          style={{ color: "var(--cli-await)" }}
        >
          Permission required
        </span>
        {/* WHO is blocked. A fan-out shares one asker, so the tool name alone
            leaves five identical rows on the graph and no way to tell which one
            is waiting. Wears that node's own palette colour, so the prompt and
            the row read as the same agent. */}
        {pending.origin ? (
          <span
            className="cli-mono inline-flex max-w-[9rem] shrink-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[10px]"
            title={`Raised by ${pending.origin.name}`}
            style={{
              color: originColor ?? "var(--cli-accent)",
              borderColor: `color-mix(in oklab, ${
                originColor ?? "var(--cli-accent)"
              } 45%, transparent)`,
            }}
          >
            <span aria-hidden="true">⚑</span>
            {pending.origin.name}
          </span>
        ) : null}
        {destructive ? (
          <span
            className="cli-mono shrink-0 rounded-full border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.1em]"
            style={{
              color: "var(--cli-fail)",
              borderColor:
                "color-mix(in oklab, var(--cli-fail) 45%, transparent)",
            }}
          >
            destructive
          </span>
        ) : null}
        <span
          className="cli-mono min-w-0 flex-1 truncate text-[11.5px] text-foreground/85"
          title={head}
        >
          {head}
        </span>
        {queued > 0 ? (
          <span className="cli-mono shrink-0 text-[10px] text-muted-foreground/70">
            +{queued} queued
          </span>
        ) : null}

        {body.length > 0 ? (
          <button
            type="button"
            className={cn(btn, "px-2")}
            aria-expanded={open}
            onClick={() => setShowPreview((v) => !v)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {open ? "hide" : "preview"}
          </button>
        ) : null}

        {destructive && !confirming ? (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={12}
              strokeWidth={2}
            />
            Allow…
          </button>
        ) : (
          <>
            <button
              type="button"
              className={cn(
                btn,
                destructive &&
                  "border-[color:var(--cli-fail)] text-[color:var(--cli-fail)]",
              )}
              disabled={busy}
              onClick={() => void answer("allow")}
            >
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={12}
                strokeWidth={2}
              />
              {destructive ? "Confirm allow once" : "Allow once"}
            </button>
            <button
              type="button"
              className={btn}
              disabled={busy}
              title={`Approve this and every future ${pending.tool} call in this session`}
              onClick={() => void answer("allow_always")}
            >
              Always {pending.tool}
            </button>
          </>
        )}
        <button
          type="button"
          className={cn(
            btn,
            "hover:border-[color:var(--cli-fail)] hover:text-[color:var(--cli-fail)]",
          )}
          disabled={busy}
          onClick={() => void answer("deny")}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </button>
        {destructive && confirming ? (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {/* the command / diff body — floats over the graph instead of displacing
          it, so opening and closing it costs the layout nothing */}
      {open ? (
        <div
          className="absolute inset-x-0 top-full max-h-[min(52vh,380px)] overflow-auto border-b border-border/60 px-4 py-2 shadow-lg"
          style={{
            background: "color-mix(in oklab, var(--cli-await) 6%, var(--card))",
          }}
        >
          {body.map((line, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static preview lines, never reordered
              key={i}
              className="cli-mono whitespace-pre text-[10.5px] leading-[1.5]"
              style={{ color: previewLineColor(line) }}
            >
              {line.length > 0 ? line : " "}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
