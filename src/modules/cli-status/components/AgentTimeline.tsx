import { Fragment } from "react";
import { type DerivedAgent, IDLE_MS, isActiveAgent } from "../lib/dashboard";

const WINDOW_MS = 240_000; // 4 minutes

type Seg = { left: number; width: number; opacity: number; now: boolean };

/**
 * One honest active span per agent, derived from real timestamps
 * (`startedAt` → last activity, extended to `now` while genuinely active).
 * No `startedAt`, or all activity before the window ⇒ null (empty lane) — we
 * never synthesize invented on/off history.
 */
function segFor(
  agent: DerivedAgent,
  now: number,
  windowStart: number,
): Seg | null {
  if (agent.startedAt == null) return null;
  const active = isActiveAgent(agent);
  const idle =
    agent.lastActivityAt != null && now - agent.lastActivityAt > IDLE_MS;
  const end = active && !idle ? now : (agent.lastActivityAt ?? now);
  const start = Math.max(agent.startedAt, windowStart);
  const clampedEnd = Math.min(end, now);
  if (clampedEnd <= windowStart || clampedEnd <= start) return null;
  const span = WINDOW_MS;
  return {
    left: ((start - windowStart) / span) * 100,
    width: Math.max(1, ((clampedEnd - start) / span) * 100),
    opacity: idle || !active ? 0.5 : 0.9,
    now: active && !idle,
  };
}

export function AgentTimeline({
  agents,
  now,
}: {
  agents: DerivedAgent[];
  now: number;
}) {
  const windowStart = now - WINDOW_MS;
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-1.5">
      {agents.map((a) => {
        const seg = segFor(a, now, windowStart);
        return (
          <Fragment key={a.id}>
            <div
              className="cli-mono truncate text-right text-[10.5px]"
              style={{ color: a.colorVar }}
            >
              {a.name}
            </div>
            <div className="cli-lane">
              {seg ? (
                <span
                  className="cli-seg"
                  style={{
                    left: `${seg.left}%`,
                    width: `${seg.width}%`,
                    background: a.colorVar,
                    opacity: seg.opacity,
                  }}
                />
              ) : null}
              {seg?.now ? <span className="cli-nowline" /> : null}
            </div>
          </Fragment>
        );
      })}
      <div />
      <div className="cli-mono mt-0.5 flex justify-between text-[9px] text-muted-foreground/70">
        <span>-4m</span>
        <span>-3m</span>
        <span>-2m</span>
        <span>-1m</span>
        <span>now</span>
      </div>
    </div>
  );
}
