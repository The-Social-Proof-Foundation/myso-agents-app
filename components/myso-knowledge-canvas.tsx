"use client";
import { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { DEFAULT_RENDER_SETTINGS } from "@/src/core";
import { GraphCanvasRenderer, type CanvasNode } from "./graph-canvas";
import { KNOWLEDGE_STATES, KNOWLEDGE_STATE_STYLE, mixHex, seedBeside, type KnowledgeCanvasGraph, type KnowledgeNodeState } from "./myso-knowledge-canvas-data";

/** Resolve a CSS variable to #rrggbb via a 1px canvas (canvas fills want hex). */
function tokenHex(element: Element, cssVar: string, fallback: string): string {
    const value = getComputedStyle(element).getPropertyValue(cssVar).trim();
    if (!value) return fallback;
    const canvas = document.createElement("canvas");canvas.width = 1;canvas.height = 1;
    const ctx = canvas.getContext("2d");if (!ctx) return fallback;
    ctx.fillStyle = value;ctx.fillRect(0, 0, 1, 1);
    const { data } = ctx.getImageData(0, 0, 1, 1);
    return `#${[data[0]!, data[1]!, data[2]!].map(part => part.toString(16).padStart(2, "0")).join("")}`;
}
function stateFills(element: Element): Record<KnowledgeNodeState, string> {
    const background = tokenHex(element, "--card", "#ffffff");
    return Object.fromEntries(KNOWLEDGE_STATES.map(state => {
        const style = KNOWLEDGE_STATE_STYLE[state];
        return [state, mixHex(tokenHex(element, style.token, "#888888"), background, style.alpha)];
    })) as Record<KnowledgeNodeState, string>;
}

/** Live pan/zoom/force view of an opened MyData graph. Layout lives only in
 *  this view: positions are never committed to the teaching graph ledger. */
export function MySoKnowledgeCanvas({ graph, highlight, selectedId, onSelect }: { graph: KnowledgeCanvasGraph; highlight: ReadonlySet<string> | null; selectedId: string | null; onSelect: (id: string) => void }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<GraphCanvasRenderer | null>(null);
    /** The renderer's sim mutates these objects in place: they ARE the live positions. */
    const liveNodes = useRef(new Map<string, CanvasNode>());
    const onSelectRef = useRef(onSelect);
    const [theme, setTheme] = useState(0);
    useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
    useEffect(() => {
        const canvas = canvasRef.current;if (!canvas) return;
        const nodes = liveNodes.current;
        const renderer = new GraphCanvasRenderer(canvas, {
            onSelect: id => onSelectRef.current(id),
            onContext: () => {},
            onStageClick: () => {},
            onCameraMove: () => {},
            onCommit: () => {},
        });
        renderer.setSettings(DEFAULT_RENDER_SETTINGS);
        rendererRef.current = renderer;
        const observer = new MutationObserver(() => setTheme(value => value + 1));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
        return () => { observer.disconnect();renderer.destroy();rendererRef.current = null;nodes.clear(); };
    }, []);
    useEffect(() => {
        const renderer = rendererRef.current, canvas = canvasRef.current;if (!renderer || !canvas) return;
        const fills = stateFills(canvas);
        const previous = liveNodes.current;const next = new Map<string, CanvasNode>();
        let added = false;
        for (const node of graph.nodes) {
            const live = previous.get(node.id);
            if (live) { live.label = node.label;live.fill = fills[node.state];next.set(node.id, live);continue; }
            added = true;
            // Seed beside an already-placed live neighbor, else at the data seed.
            const neighbor = graph.edges.map(edge => edge.sourceId === node.id ? edge.targetId : edge.targetId === node.id ? edge.sourceId : null).map(id => id ? previous.get(id) : undefined).find(Boolean);
            next.set(node.id, { id: node.id, label: node.label, fill: fills[node.state], ...(neighbor ? seedBeside(neighbor, node.id) : { x: node.x, y: node.y }) });
        }
        liveNodes.current = next;
        renderer.setData({
            nodes: [...next.values()],
            edges: graph.edges.map(edge => ({ from: edge.sourceId, to: edge.targetId })),
            clusters: [],
            colors: { node: fills.asserted, edge: tokenHex(canvas, "--muted-foreground", "#888888"), label: tokenHex(canvas, "--muted-foreground", "#888888"), hoverText: tokenHex(canvas, "--foreground", "#000000") },
            fontFamily: getComputedStyle(document.body).fontFamily,
        });
        if (added) renderer.reheat();
    }, [graph, theme]);
    useEffect(() => {
        const ids = highlight ? new Set(highlight) : null;
        if (ids && selectedId) ids.add(selectedId);
        rendererRef.current?.setHighlight(ids && ids.size > 0 ? ids : null);
    }, [highlight, selectedId, graph]);
    return <div className="myso-knowledge-canvas">
        <canvas ref={canvasRef} aria-label={`Graph view with ${graph.nodes.length} records. Use the list beside it to select records with the keyboard.`} role="img"/>
        <div className="myso-knowledge-canvas-bar">
            <ul className="myso-knowledge-legend" aria-label="Record states">{KNOWLEDGE_STATES.map(state => <li key={state}><span className={`myso-state-dot myso-state-${state}`} aria-hidden="true"/>{KNOWLEDGE_STATE_STYLE[state].label}</li>)}</ul>
            <button type="button" className="myso-text-button" onClick={() => rendererRef.current?.fit()}><Maximize2 size={14}/>Fit to view</button>
        </div>
    </div>;
}
