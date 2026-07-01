import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAutocompleteEnabled } from "@/modules/settings/store";

// Copilot-style status-bar badge that surfaces the (otherwise hidden, off-by-
// default) AI ghost-text autocomplete. Click toggles it on/off; the tooltip
// documents the accept/dismiss keys and points at Settings → Models for the
// provider/model/key it needs to actually produce suggestions.
export function AiAutocompleteStatus() {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void setAutocompleteEnabled(!enabled)}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors hover:bg-accent hover:text-foreground",
            enabled ? "text-foreground" : "text-muted-foreground/50",
          )}
        >
          <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
          <span>AI</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {enabled
          ? "AI autocomplete is on. Keep typing for ghost-text suggestions — Tab to accept, Ctrl+→ for one word, Alt+\\ to trigger, Esc to dismiss. Click to turn off."
          : "AI autocomplete is off. Click to turn it on, then pick a provider, model and API key in Settings → Models."}
      </TooltipContent>
    </Tooltip>
  );
}
