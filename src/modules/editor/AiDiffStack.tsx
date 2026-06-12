import type { AiDiffTab, Tab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onAccept: (approvalId: string, sessionId: string) => void;
  onReject: (approvalId: string, sessionId: string) => void;
};

export function AiDiffStack({ tabs, activeId, onAccept, onReject }: Props) {
  const active = tabs.find(
    (t): t is AiDiffTab => t.kind === "ai-diff" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <div className="h-full w-full">
      <AiDiffPane
        key={active.id}
        path={active.path}
        originalContent={active.originalContent}
        proposedContent={active.proposedContent}
        status={active.status}
        isNewFile={active.isNewFile}
        onAccept={() => onAccept(active.approvalId, active.sessionId)}
        onReject={() => onReject(active.approvalId, active.sessionId)}
      />
    </div>
  );
}
