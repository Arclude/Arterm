// Pure, DOM-free topology model for the CLI Agents graph view. Everything here
// derives from a StatusSnapshot — no invented data — and returns plain objects
// so both the node/edge build and the tidy-tree layout are unit-testable without
// a renderer. The React-Flow component (TopologyGraph.tsx) is the only consumer.

import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StampedEvent, StatusSnapshot, TeamMessageEvent } from "../types";
import {
  type DerivedAgent,
  deriveSessionNodes,
  isActiveAgent,
} from "./dashboard";

/** A structural star edge (`"tree"`, the default) or a shared-blackboard
 *  message edge (`"message"`, derived from the stream, not the snapshot). */
export type TopoEdgeKind = "tree" | "message";

export type TopoEdge = {
  id: string;
  source: string;
  target: string;
  /** true when the edge's target agent is actively working (drives animation). */
  animated: boolean;
  /** Edge role. Omitted is treated as `"tree"`. */
  kind?: TopoEdgeKind;
  /** message edges only: true = a directed member→member (or leader→member)
   *  note; false = a broadcast / round result collapsed onto the member→hub edge. */
  directed?: boolean;
  /** message edges only: how many postings this edge aggregates. */
  count?: number;
  /** message edges only: the most-recent posting's text (for a hover/label). */
  latestText?: string;
  /** message edges only: the most-recent posting's 1-based team round. */
  round?: number;
};

/** A node kind in the graph: a session root (global view only) or one of the
 *  three agent kinds. */
export type TopoNodeKind = "session" | "main" | "member" | "worker";

/**
 * A renderable graph node, shared by both views. Agent nodes carry a
 * `DerivedAgent`; session-root nodes (global view) carry the source `entry` so
 * the component can render its label / counts / status dot from existing helpers.
 * `sessionId` (owner) + `agentId` (plain, un-namespaced) power click selection.
 */
export type TopoNode = {
  id: string; // React-Flow node id — namespaced per session in the global view
  kind: TopoNodeKind;
  sessionId: string;
  agent?: DerivedAgent; // main | member | worker
  entry?: CliSessionEntry; // session
  agentId?: string; // plain agent id (agent nodes) for drilldown selection
};

export type TopoGraph = {
  nodes: TopoNode[];
  edges: TopoEdge[];
};

/** Narrow a stream event to a `team_message` posting, validating every field
 *  defensively (the desktop treats payloads as opaque). Returns null otherwise.
 *  Exported so the blackboard panel derives its rows from the same parse. */
export function asTeamMessage(ev: StampedEvent): TeamMessageEvent | null {
  if (ev.type !== "team_message") return null;
  const from = typeof ev.from === "string" ? ev.from : undefined;
  const kind =
    ev.kind === "message" || ev.kind === "result" ? ev.kind : undefined;
  if (!from || !kind) return null;
  return {
    ...ev,
    type: "team_message",
    round: typeof ev.round === "number" ? ev.round : 0,
    from,
    fromName: typeof ev.fromName === "string" ? ev.fromName : from,
    to: typeof ev.to === "string" ? ev.to : undefined,
    toName: typeof ev.toName === "string" ? ev.toName : undefined,
    kind,
    text: typeof ev.text === "string" ? ev.text : "",
  };
}

/**
 * Derive shared-blackboard edges from a session's event feed. A directed
 * `kind:"message"` (with `to`) becomes a member→member edge (`from`→`to`);
 * broadcasts and round `result`s collapse onto a single member→hub edge. Postings
 * between the same pair are aggregated (count + latest text/round). `resolve` maps
 * a contract id (`"leader"` or a member id) to its graph node id, and only edges
 * whose BOTH endpoints currently exist (`has`) are emitted — a note about a
 * vanished member is dropped, never left dangling. Pure and order-independent.
 */
function messageEdges(
  feed: StampedEvent[],
  hubId: string,
  resolve: (who: string) => string,
  has: (nodeId: string) => boolean,
): TopoEdge[] {
  type Agg = {
    source: string;
    target: string;
    count: number;
    latestText: string;
    latestSeq: number;
    round: number;
    directed: boolean;
  };
  const agg = new Map<string, Agg>();
  for (const ev of feed) {
    const m = asTeamMessage(ev);
    if (!m) continue;
    // `to` is only meaningful for a directed message; a result never has one.
    const to = m.kind === "message" ? m.to : undefined;
    const source = resolve(m.from);
    const target = to !== undefined ? resolve(to) : hubId;
    const directed = to !== undefined;
    if (source === target) continue; // no self-loop (e.g. a leader broadcast)
    if (!has(source) || !has(target)) continue; // endpoint vanished — drop
    const key = `${source}->${target}`;
    const prev = agg.get(key);
    if (prev) {
      prev.count += 1;
      prev.directed = prev.directed || directed;
      if (m.seq >= prev.latestSeq) {
        prev.latestSeq = m.seq;
        prev.latestText = m.text;
        prev.round = m.round;
      }
    } else {
      agg.set(key, {
        source,
        target,
        count: 1,
        latestText: m.text,
        latestSeq: m.seq,
        round: m.round,
        directed,
      });
    }
  }
  const edges: TopoEdge[] = [];
  for (const a of agg.values()) {
    edges.push({
      id: `msg:${a.source}->${a.target}`,
      source: a.source,
      target: a.target,
      animated: false,
      kind: "message",
      directed: a.directed,
      count: a.count,
      latestText: a.latestText,
      round: a.round,
    });
  }
  return edges;
}

/**
 * The focused session's topology: one main coordinator with every team member
 * and fleet worker hanging off it (a 2-level tree, per the protocol). Edges
 * animate when the child is active. A solo session yields a single main node
 * with no edges. Node ids are the plain agent ids (single-session scope). The
 * optional `feed` layers in shared-blackboard member↔member message edges (a
 * stream-only signal absent from the snapshot).
 */
export function buildSessionTopology(
  snapshot: StatusSnapshot,
  feed: StampedEvent[] = [],
): TopoGraph {
  const agents = deriveSessionNodes(snapshot);
  const main = agents.find((a) => a.kind === "main") ?? agents[0];
  const nodes: TopoNode[] = agents.map((agent) => ({
    id: agent.id,
    kind: agent.kind,
    sessionId: snapshot.sessionId,
    agent,
    agentId: agent.id,
  }));
  const edges: TopoEdge[] = main
    ? agents
        .filter((a) => a.id !== main.id)
        .map((a) => ({
          id: `${main.id}->${a.id}`,
          source: main.id,
          target: a.id,
          animated: isActiveAgent(a),
          kind: "tree" as const,
        }))
    : [];
  if (main && feed.length > 0) {
    const ids = new Set(nodes.map((n) => n.id));
    const resolve = (who: string) => (who === "leader" ? main.id : who);
    edges.push(...messageEdges(feed, main.id, resolve, (id) => ids.has(id)));
  }
  return { nodes, edges };
}

/**
 * The global topology across every LIVE session: a `session` root per session →
 * its `main` → that session's members/workers (a 3-level tree; columns
 * session → main → member/worker). Node ids are namespaced by session so ids
 * collide across sessions (`main` exists in each). Only live, snapshot-bearing
 * sessions are included — lost/connecting ones are skipped.
 */
export function buildGlobalTopology(entries: CliSessionEntry[]): TopoGraph {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  for (const entry of entries) {
    const snapshot = entry.snapshot;
    if (entry.connection !== "live" || !snapshot) continue;
    const sid = entry.info.sessionId;
    const sessionNodeId = `s:${sid}`;
    nodes.push({ id: sessionNodeId, kind: "session", sessionId: sid, entry });

    const agents = deriveSessionNodes(snapshot);
    const main = agents.find((a) => a.kind === "main") ?? agents[0];
    const nodeIds = new Set<string>([sessionNodeId]);
    for (const agent of agents) {
      const nodeId = `${sid}:${agent.id}`;
      nodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        kind: agent.kind,
        sessionId: sid,
        agent,
        agentId: agent.id,
      });
    }
    if (!main) continue;
    const mainNodeId = `${sid}:${main.id}`;
    // session → main (animated while the session is busy)
    edges.push({
      id: `${sessionNodeId}->${mainNodeId}`,
      source: sessionNodeId,
      target: mainNodeId,
      animated: snapshot.activeAgents > 0,
      kind: "tree",
    });
    // main → each member / worker (animated when that child is active)
    for (const agent of agents) {
      if (agent.id === main.id) continue;
      edges.push({
        id: `${mainNodeId}->${sid}:${agent.id}`,
        source: mainNodeId,
        target: `${sid}:${agent.id}`,
        animated: isActiveAgent(agent),
        kind: "tree",
      });
    }
    // shared-blackboard member↔member edges (stream-only; namespaced per session)
    const resolve = (who: string) =>
      `${sid}:${who === "leader" ? main.id : who}`;
    edges.push(
      ...messageEdges(entry.feed, mainNodeId, resolve, (id) => nodeIds.has(id)),
    );
  }
  return { nodes, edges };
}

export type XY = { x: number; y: number };

export type TidyOptions = { colGap?: number; rowGap?: number };

/**
 * Hierarchical tidy-tree layout for a rooted forest. Each node sits in a fixed
 * column by its depth (`x = depth * colGap`); leaves are packed onto sequential
 * vertical slots and every parent is centered over the span of its children — so
 * main sits centered against its members/workers. Pure and deterministic:
 * returns a `Map<id, {x, y}>`, so it needs no DOM to test. Orphans (or nodes
 * stranded by a cycle) are stacked in the first column after the real tree.
 */
export function layoutTidyTree(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  opts: TidyOptions = {},
): Map<string, XY> {
  const colGap = opts.colGap ?? 240;
  const rowGap = opts.rowGap ?? 88;

  const ids = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const arr = childrenOf.get(e.source);
    if (arr) arr.push(e.target);
    else childrenOf.set(e.source, [e.target]);
    hasParent.add(e.target);
  }

  const pos = new Map<string, XY>();
  const visiting = new Set<string>();
  let nextSlot = 0;

  const place = (id: string, depth: number): number => {
    const existing = pos.get(id);
    if (existing) return existing.y; // already placed (shared child) — reuse
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const kids = childrenOf.get(id) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = nextSlot * rowGap;
      nextSlot += 1;
    } else {
      const ys = kids.map((k) => place(k, depth + 1));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    visiting.delete(id);
    pos.set(id, { x: depth * colGap, y });
    return y;
  };

  // Roots first (no parent), in input order for stable packing.
  for (const n of nodes) if (!hasParent.has(n.id)) place(n.id, 0);
  // Anything still unplaced (stranded by a cycle) stacks at column 0.
  for (const n of nodes) {
    if (!pos.has(n.id)) {
      pos.set(n.id, { x: 0, y: nextSlot * rowGap });
      nextSlot += 1;
    }
  }
  return pos;
}
