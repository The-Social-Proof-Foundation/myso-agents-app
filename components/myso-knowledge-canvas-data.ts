/** Graph record states (the MySo knowledge-graph contract's graphState). */
export type KnowledgeNodeState = "asserted" | "verified" | "disputed" | "superseded" | "revoked";
/** Structural slices of the graph contract's node/edge records: only the
 *  fields the canvas draws (keeps this module inside the core-barrel law). */
interface GraphNodeInput { id: string; label: string; kind: string; state: KnowledgeNodeState }
interface GraphEdgeInput { id: string; sourceId: string; targetId: string; kind: string; state: KnowledgeNodeState }

/** One opened-graph node on the Knowledge canvas (MyData typed JSON graph). */
export type KnowledgeCanvasNode = GraphNodeInput & { x: number; y: number };
export type KnowledgeCanvasEdge = GraphEdgeInput;
export interface KnowledgeCanvasGraph { nodes: KnowledgeCanvasNode[]; edges: KnowledgeCanvasEdge[] }

export const EMPTY_KNOWLEDGE_GRAPH: KnowledgeCanvasGraph = { nodes: [], edges: [] };

/** State → theme token (owner decision, October 27, 2026: palette-only). */
export const KNOWLEDGE_STATE_STYLE: Record<KnowledgeNodeState, { token: string; alpha: number; label: string }> = {
    verified: { token: "--highlight", alpha: 1, label: "Verified" },
    asserted: { token: "--foreground", alpha: 1, label: "Asserted" },
    disputed: { token: "--destructive", alpha: 1, label: "Disputed" },
    superseded: { token: "--muted-foreground", alpha: 1, label: "Superseded" },
    revoked: { token: "--destructive", alpha: 0.45, label: "Revoked" },
};
export const KNOWLEDGE_STATES: KnowledgeNodeState[] = ["verified", "asserted", "disputed", "superseded", "revoked"];

/** Blend a #rrggbb toward a #rrggbb background (canvas fills want opaque hex). */
export function mixHex(color: string, background: string, alpha: number): string {
    const parse = (hex: string) => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
    const a = parse(color), b = parse(background);
    if (a.some(Number.isNaN) || b.some(Number.isNaN)) return color;
    return `#${a.map((value, index) => Math.round(value * alpha + b[index]! * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

const SEED_RADIUS = 40;
const NEIGHBOR_RADIUS = 18;

/** Stable angle from an id, so seeding is deterministic. */
function idAngle(id: string): number {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}
/** Where a new node starts beside an already-placed neighbor. */
export function seedBeside(anchor: { x: number; y: number }, id: string): { x: number; y: number } {
    const angle = idAngle(id);
    return { x: anchor.x + Math.cos(angle) * NEIGHBOR_RADIUS, y: anchor.y + Math.sin(angle) * NEIGHBOR_RADIUS };
}

/** Merge new nodes/edges into the drawn graph. Existing nodes keep their
 *  positions (state/label refresh in place); new nodes seed beside an
 *  already-placed neighbor, else on a ring, for the live sim to settle.
 *  Edges are kept only when both ends are known nodes. */
export function mergeKnowledgeGraph(current: KnowledgeCanvasGraph, nodes: readonly GraphNodeInput[], edges: readonly GraphEdgeInput[]): KnowledgeCanvasGraph {
    const byId = new Map(current.nodes.map(node => [node.id, node]));
    const incoming = nodes.filter((node, index) => nodes.findIndex(other => other.id === node.id) === index);
    const fresh = incoming.filter(node => !byId.has(node.id));
    for (const node of incoming) {
        const existing = byId.get(node.id);
        if (existing) byId.set(node.id, { ...existing, label: node.label, kind: node.kind, state: node.state });
    }
    const edgeById = new Map(current.edges.map(edge => [edge.id, edge]));
    for (const edge of edges) edgeById.set(edge.id, { id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, kind: edge.kind, state: edge.state });
    const ringStart = byId.size;
    fresh.forEach((node, index) => {
        const neighborId = [...edgeById.values()].map(edge => edge.sourceId === node.id ? edge.targetId : edge.targetId === node.id ? edge.sourceId : null).find(id => id !== null && byId.has(id));
        const anchor = neighborId ? byId.get(neighborId)! : null;
        const ring = (ringStart + index) * (Math.PI * 2 / Math.max(6, ringStart + fresh.length));
        byId.set(node.id, anchor
            ? { id: node.id, label: node.label, kind: node.kind, state: node.state, ...seedBeside(anchor, node.id) }
            : { id: node.id, label: node.label, kind: node.kind, state: node.state, x: Math.cos(ring) * SEED_RADIUS, y: Math.sin(ring) * SEED_RADIUS });
    });
    return { nodes: [...byId.values()], edges: [...edgeById.values()].filter(edge => byId.has(edge.sourceId) && byId.has(edge.targetId) && edge.sourceId !== edge.targetId) };
}
