/**
 * Knowledge canvas adapter (components/myso-knowledge-canvas-data.ts): an
 * opened MyData graph mapped onto the live renderer. The renderer itself is
 * DOM-bound; the merge/seed/color rules it is fed are pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_KNOWLEDGE_GRAPH, KNOWLEDGE_STATE_STYLE, KNOWLEDGE_STATES, mergeKnowledgeGraph, mixHex, seedBeside } from "../components/myso-knowledge-canvas-data.ts";
import type { MySoGraphEdge, MySoGraphNode } from "../src/core/contracts/myso-knowledge-graph.ts";

const node = (id: string, state: MySoGraphNode["state"] = "asserted"): MySoGraphNode => ({ id, kind: "concept", label: `Label ${id}`, statement: "", aliases: [], evidenceIds: [], state });
const edge = (id: string, sourceId: string, targetId: string): MySoGraphEdge => ({ id, kind: "related_to", sourceId, targetId, evidenceIds: [], state: "asserted" });

describe("mergeKnowledgeGraph", () => {
	it("seeds search matches on a ring and keeps only edges between known nodes", () => {
		const graph = mergeKnowledgeGraph(EMPTY_KNOWLEDGE_GRAPH, [node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "a", "unknown")]);
		assert.deepEqual(graph.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(graph.edges.map((e) => e.id), ["e1"]);
		for (const n of graph.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
		assert.notDeepEqual([graph.nodes[0]!.x, graph.nodes[0]!.y], [graph.nodes[1]!.x, graph.nodes[1]!.y]);
	});

	it("accumulates an inspected neighborhood without moving placed nodes", () => {
		const first = mergeKnowledgeGraph(EMPTY_KNOWLEDGE_GRAPH, [node("a")], []);
		const a = first.nodes[0]!;
		const next = mergeKnowledgeGraph(first, [node("a", "verified"), node("c")], [edge("e3", "a", "c"), edge("e2", "a", "unknown")]);
		const placedA = next.nodes.find((n) => n.id === "a")!;
		assert.equal(placedA.x, a.x);
		assert.equal(placedA.y, a.y);
		assert.equal(placedA.state, "verified", "state refreshes in place");
		const c = next.nodes.find((n) => n.id === "c")!;
		assert.deepEqual({ x: c.x, y: c.y }, seedBeside(a, "c"), "a new node seeds beside its placed neighbor");
		assert.deepEqual(next.edges.map((e) => e.id), ["e3"]);
	});

	it("drops self-loops and duplicate incoming nodes", () => {
		const graph = mergeKnowledgeGraph(EMPTY_KNOWLEDGE_GRAPH, [node("a"), node("a")], [edge("loop", "a", "a")]);
		assert.equal(graph.nodes.length, 1);
		assert.equal(graph.edges.length, 0);
	});
});

describe("state colors", () => {
	it("maps every graph state to a theme token (palette-only)", () => {
		assert.deepEqual(KNOWLEDGE_STATES, ["verified", "asserted", "disputed", "superseded", "revoked"]);
		assert.equal(KNOWLEDGE_STATE_STYLE.verified.token, "--highlight");
		assert.equal(KNOWLEDGE_STATE_STYLE.disputed.token, "--destructive");
		assert.equal(KNOWLEDGE_STATE_STYLE.revoked.token, "--destructive");
		assert.ok(KNOWLEDGE_STATE_STYLE.revoked.alpha < 1, "revoked is the faded destructive");
	});

	it("mixHex blends toward the background and is identity at alpha 1", () => {
		assert.equal(mixHex("#ff0000", "#ffffff", 1), "#ff0000");
		assert.equal(mixHex("#ff0000", "#ffffff", 0), "#ffffff");
		assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
		assert.equal(mixHex("oklch(1 0 0)", "#ffffff", 0.5), "oklch(1 0 0)", "non-hex input passes through");
	});
});
