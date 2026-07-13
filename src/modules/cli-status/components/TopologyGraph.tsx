import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowExpandDiagonal01Icon,
  ArrowShrink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildGlobalTopology,
  buildSessionTopology,
  layoutTidyTree,
  type TopoNode,
} from "../lib/topology";
import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StampedEvent, StatusSnapshot } from "../types";
import { AgentFlowNode } from "./AgentFlowNode";
import { BlackboardEdge } from "./BlackboardEdge";

// Stable identity — React Flow warns (and re-mounts nodes/edges) if this changes.
const nodeTypes = { agent: AgentFlowNode };
const edgeTypes = { blackboard: BlackboardEdge };

/** Compose the hover text for a blackboard edge from its aggregate fields. A
 *  directed edge is a teammate note; an undirected one collapses broadcasts and
 *  round results onto the member→hub arc, so it reads generically as "→ board". */
function edgeTooltip(
  directed: boolean,
  count: number,
  round: number,
  latestText: string,
): string {
  const role = directed ? "teammate message" : "posted to board";
  const latest = latestText.replace(/\s+/g, " ").trim();
  const short = latest.length > 200 ? `${latest.slice(0, 200)}…` : latest;
  const head = `${role}${count > 1 ? ` · ${count} postings` : ""}${
    round ? ` · round ${round}` : ""
  }`;
  return short ? `${head}\n${short}` : head;
}
const COL_GAP = 260;
const ROW_GAP = 104;

export type TopologyMode = "focused" | "all";

type TopologyGraphProps = {
  /** "focused" = the selected session's tree; "all" = every live session. */
  mode: TopologyMode;
  /** Focused session's snapshot (used in "focused" mode). */
  snapshot: StatusSnapshot;
  /** Focused session's rolling event feed — the source of the stream-only
   *  blackboard message edges (used in "focused" mode; "all" reads each entry's
   *  own feed). */
  feed: StampedEvent[];
  /** All live entries (used in "all" mode). */
  entries: CliSessionEntry[];
  selectedAgentId: string | null;
  selectedSessionId: string | null;
  onSelectAgent: (id: string) => void;
  onSelectSession: (id: string) => void;
  /** Session-node click: focus that session AND switch back to the focused view. */
  onFocusSession: (id: string) => void;
  /** Graph is expanded to fill the whole center (timeline/rows hidden). */
  maximized: boolean;
  onToggleMaximize: () => void;
  /** Whether the dashboard tab is actually visible. React-Flow's absolutely
   *  positioned panes ignore an ancestor's `visibility:hidden`, so we must not
   *  mount `<ReactFlow>` while the tab is hidden — else its nodes/MiniMap leak
   *  on top of whatever tab (e.g. a terminal) is active. */
  active: boolean;
};

type TopologyInnerProps = Omit<TopologyGraphProps, "active">;

function TopologyInner({
  mode,
  snapshot,
  feed,
  entries,
  selectedAgentId,
  selectedSessionId,
  onSelectAgent,
  onSelectSession,
  onFocusSession,
  maximized,
  onToggleMaximize,
}: TopologyInnerProps) {
  const { nodes: topoNodes, edges: topoEdges } = useMemo(
    () =>
      mode === "all"
        ? buildGlobalTopology(entries)
        : buildSessionTopology(snapshot, feed),
    [mode, entries, snapshot, feed],
  );
  // Layout is a strict tree — message edges (member↔member) would reparent nodes,
  // so the tidy-tree sees only the structural star edges.
  const treeEdges = useMemo(
    () => topoEdges.filter((e) => e.kind !== "message"),
    [topoEdges],
  );
  const layout = useMemo(
    () =>
      layoutTidyTree(
        topoNodes.map((n) => ({ id: n.id })),
        treeEdges,
        { colGap: COL_GAP, rowGap: ROW_GAP },
      ),
    [topoNodes, treeEdges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Once the user drags a node we stop repositioning on snapshot refresh, so a
  // manual arrangement survives the 2s polls (data still updates in place).
  const userArrangedRef = useRef(false);
  const { fitView } = useReactFlow();

  const isSelected = useCallback(
    (node: TopoNode): boolean =>
      node.kind === "session"
        ? node.sessionId === selectedSessionId
        : node.agentId === selectedAgentId &&
          node.sessionId === selectedSessionId,
    [selectedAgentId, selectedSessionId],
  );

  useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return topoNodes.map((node) => ({
        id: node.id,
        type: "agent",
        position: (userArrangedRef.current
          ? prevPos.get(node.id)
          : undefined) ??
          layout.get(node.id) ?? { x: 0, y: 0 },
        data: node,
        selected: isSelected(node),
      }));
    });
  }, [topoNodes, layout, isSelected, setNodes]);

  useEffect(() => {
    setEdges(
      topoEdges.map((e) => {
        if (e.kind === "message") {
          // Blackboard edge: a directed member↔member note (prominent violet
          // bezier) or a broadcast / round result collapsed onto a faint dashed
          // member→hub edge. Distinct from the teal structural star edges. The
          // custom `blackboard` edge adds a hover tooltip with the latest text.
          const directed = e.directed ?? false;
          const color = directed ? "var(--cli-a-purple)" : "var(--cli-idle)";
          const count = e.count ?? 1;
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: "blackboard",
            animated: false,
            data: {
              tooltip: edgeTooltip(
                directed,
                count,
                e.round ?? 0,
                e.latestText ?? "",
              ),
              count,
              color,
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color,
              width: 13,
              height: 13,
            },
            style: {
              stroke: color,
              strokeWidth: directed ? 1.75 : 1,
              strokeDasharray: directed ? undefined : "5 4",
              opacity: directed ? 0.95 : 0.5,
            },
          };
        }
        // Structural star edge (session → main, main ↔ member/worker).
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          animated: e.animated,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--cli-accent)",
            width: 16,
            height: 16,
          },
          style: { stroke: "var(--cli-accent)", strokeWidth: 1.5 },
        };
      }),
    );
  }, [topoEdges, setEdges]);

  // On a mode flip, drop any manual arrangement and refit to the new tree.
  useEffect(() => {
    userArrangedRef.current = false;
    const id = window.setTimeout(
      () => void fitView({ padding: 0.2, duration: 250 }),
      60,
    );
    return () => window.clearTimeout(id);
  }, [mode, fitView]);

  const autoArrange = useCallback(() => {
    userArrangedRef.current = false;
    setNodes((prev) =>
      prev.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })),
    );
    requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 300 });
    });
  }, [layout, setNodes, fitView]);

  const nodeColor = useCallback((n: Node) => {
    const node = n.data as unknown as TopoNode;
    return node.kind === "session"
      ? "var(--cli-accent)"
      : (node.agent?.colorVar ?? "var(--cli-idle)");
  }, []);

  const handleNodeClick = useCallback(
    (_: unknown, n: Node) => {
      const node = n.data as unknown as TopoNode;
      if (node.kind === "session") {
        onFocusSession(node.sessionId);
      } else if (node.agentId) {
        onSelectSession(node.sessionId);
        onSelectAgent(node.agentId);
      }
    },
    [onFocusSession, onSelectSession, onSelectAgent],
  );

  return (
    <div className="cli-flow relative h-full min-h-[220px] w-full overflow-hidden rounded-[10px] border border-border bg-card/30">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <button
          type="button"
          onClick={autoArrange}
          className="cli-mono rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground outline-none transition-colors hover:border-[color:var(--cli-accent)] hover:text-[color:var(--cli-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40"
          title="Re-run the tidy-tree layout and fit the view"
        >
          Auto arrange
        </button>
        <button
          type="button"
          onClick={onToggleMaximize}
          title={maximized ? "Restore" : "Maximize the graph"}
          aria-label={maximized ? "Restore graph" : "Maximize graph"}
          className="cli-mono inline-flex items-center rounded-md border border-border bg-card px-1.5 py-1 text-muted-foreground outline-none transition-colors hover:border-[color:var(--cli-accent)] hover:text-[color:var(--cli-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40"
        >
          <HugeiconsIcon
            icon={maximized ? ArrowShrink01Icon : ArrowExpandDiagonal01Icon}
            size={13}
            strokeWidth={2}
          />
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={() => {
          userArrangedRef.current = true;
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <MiniMap
          nodeColor={nodeColor}
          nodeStrokeWidth={2}
          pannable
          zoomable
          className="cli-flow-minimap"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** Live topology graph — the focused session (main → members/workers) or, in
 *  "all" mode, every live session (session → main → members/workers). Wrapped in
 *  its own React-Flow provider so "Auto arrange" can call fitView. Mounts
 *  React-Flow ONLY while the tab is visible — when hidden we render a bare box
 *  (same footprint) so the library's absolutely-positioned panes can never escape
 *  the hidden dashboard and paint over the active tab. Remounting on show re-runs
 *  `fitView`, so it always frames correctly. */
export function TopologyGraph({ active, ...rest }: TopologyGraphProps) {
  if (!active) {
    return (
      <div className="cli-flow relative h-full min-h-[220px] w-full overflow-hidden rounded-[10px] border border-border bg-card/30" />
    );
  }
  return (
    <ReactFlowProvider>
      <TopologyInner {...rest} />
    </ReactFlowProvider>
  );
}
