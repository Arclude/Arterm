import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSimpleBezierPath,
} from "@xyflow/react";

/** Data carried on a blackboard (`type:"blackboard"`) React-Flow edge — see the
 *  message-edge branch in TopologyGraph. `tooltip` is the human hover text
 *  (latest posting + count); `count` drives the aggregate badge; `color` matches
 *  the stroke so badge and line read as one. */
export type BlackboardEdgeData = {
  tooltip: string;
  count: number;
  color: string;
};

/**
 * Custom edge for shared-blackboard postings. Renders the same simple-bezier
 * curve as before, but adds two things the built-in edge can't: a full-width
 * transparent hit-path with a native `<title>` so hovering the arc reveals WHAT
 * teammates actually said (not just that they spoke), and the aggregate count
 * badge (kept identical to the previous look). The message text lives in the
 * snapshot-free SSE feed, so this is the only place the graph can surface it.
 */
export function BlackboardEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSimpleBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const d = (data ?? {}) as Partial<BlackboardEdgeData>;
  const tooltip = d.tooltip ?? "";
  const count = d.count ?? 1;
  const color = d.color ?? "var(--cli-a-purple)";
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {/* Fat transparent overlay so the whole arc is hoverable; the native
          <title> surfaces the latest posting with zero popover machinery. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ pointerEvents: "stroke", cursor: "help" }}
      >
        {tooltip ? <title>{tooltip}</title> : null}
      </path>
      {count > 1 ? (
        <EdgeLabelRenderer>
          <div
            className="cli-mono nodrag nopan"
            title={tooltip}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              cursor: "help",
              fontSize: 9,
              fontWeight: 600,
              color,
              background:
                "color-mix(in oklab, var(--cli-idle) 24%, transparent)",
              padding: "1px 3px",
              borderRadius: 3,
            }}
          >
            {count}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
