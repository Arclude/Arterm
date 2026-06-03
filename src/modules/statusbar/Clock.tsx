import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

function fmt(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Clock() {
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 20_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground tabular-nums">
      <HugeiconsIcon icon={Clock01Icon} size={11} strokeWidth={1.75} />
      {t}
    </span>
  );
}
