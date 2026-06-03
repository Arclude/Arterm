import { Loading03Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useWhisperRecording } from "@/modules/ai/hooks/useWhisperRecording";
import { writeToSession } from "@/modules/terminal/lib/useTerminalSession";
import { cn } from "@/lib/utils";

/**
 * Status-bar voice button: records speech and types the transcript into the
 * active terminal (Whisper via the OpenAI key). Hidden when MediaRecorder is
 * unavailable; disabled with a hint when no OpenAI key is set.
 */
export function VoiceButton({ activeLeafId }: { activeLeafId: number | null }) {
  const voice = useWhisperRecording({
    onResult: (text) => {
      if (activeLeafId != null) writeToSession(activeLeafId, text);
    },
  });

  if (!voice.supported) return null;

  const title = !voice.hasKey
    ? "Voice needs an OpenAI key"
    : voice.recording
      ? "Stop recording"
      : voice.transcribing
        ? "Transcribing…"
        : "Voice input → active terminal";

  return (
    <button
      type="button"
      title={title}
      disabled={!voice.hasKey || voice.transcribing}
      onClick={() => (voice.recording ? voice.stop() : void voice.start())}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40",
        voice.recording && "text-red-500 hover:text-red-500",
      )}
    >
      <HugeiconsIcon
        icon={voice.transcribing ? Loading03Icon : Mic01Icon}
        size={13}
        strokeWidth={1.75}
        className={voice.transcribing ? "animate-spin" : undefined}
      />
    </button>
  );
}
