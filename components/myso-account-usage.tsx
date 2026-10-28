"use client";

import { useEffect, useState } from "react";

type MemoryAgent = { agentObjectId: string; organizationId: string | null; entries: string; bytes: string; orgSharedEntries: string; updatedAt: string };
type Snapshot = {
    memory: { available: boolean; updatedAt: string | null; entries: string | null; bytes: string | null; orgSharedEntries: string | null; agents: MemoryAgent[] };
    ai: { unavailable: true; error: string } | { unavailable: false; balance: { available_mist: string; balance: { balance_mist: string; spent_total_mist: string; reserved_mist: string } }; usage: Array<Record<string, unknown>> };
};

function count(value: string) {
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function MySoAccountUsage() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        let timer = 0;
        async function load() {
            try {
                const response = await fetch("/api/myso/account/usage", { cache: "no-store" });
                const body = await response.json() as Snapshot & { error?: string };
                if (!response.ok) throw new Error(body.error ?? "Account usage is unavailable");
                if (active) { setSnapshot(body); setError(""); }
            } catch (reason) {
                if (active) setError(reason instanceof Error ? reason.message : "Account usage is unavailable");
            }
        }
        function tick() {
            if (!active || document.visibilityState !== "visible") return;
            void load();
            timer = window.setTimeout(tick, 30_000);
        }
        function onVisibility() {
            window.clearTimeout(timer);
            if (document.visibilityState === "visible") tick();
        }
        document.addEventListener("visibilitychange", onVisibility);
        tick();
        return () => { active = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
    }, []);
    const memory = snapshot?.memory;
    const ai = snapshot?.ai;
    return <section className="myso-create" aria-label="Account usage">
        <div className="myso-page-heading"><div><p className="myso-eyebrow">ACCOUNT USAGE</p><h2>Memory and AI credit</h2></div></div>
        <p className="myso-knowledge-note">These figures refresh every 30 seconds while this screen is open. Memory totals are the latest stored snapshot, not a live counter.</p>
        {error && <p className="myso-knowledge-note" role="alert">{error}</p>}
        {!snapshot && !error && <p className="myso-loading" role="status">Loading account usage…</p>}
        {memory && (memory.available && memory.entries && memory.bytes && memory.orgSharedEntries ? <>
            <p className="myso-knowledge-note">Stored snapshot {memory.updatedAt ? new Date(memory.updatedAt).toLocaleString() : "time unavailable"} · {count(memory.entries)} entries · {count(memory.bytes)} bytes · {count(memory.orgSharedEntries)} organization-shared entries</p>
            <ul>{memory.agents.map(agent => <li key={agent.agentObjectId}><code>{agent.agentObjectId}</code><small>{count(agent.entries)} entries · {count(agent.bytes)} bytes · {count(agent.orgSharedEntries)} shared</small></li>)}</ul>
        </> : <p className="myso-knowledge-note">The stored memory snapshot is unavailable for this account.</p>)}
        {ai?.unavailable && <p className="myso-knowledge-note">{ai.error}</p>}
        {ai && !ai.unavailable && <>
            <p className="myso-knowledge-note">AI credit available {count(ai.balance.available_mist)} MIST · balance {count(ai.balance.balance.balance_mist)} · spent {count(ai.balance.balance.spent_total_mist)} · reserved {count(ai.balance.balance.reserved_mist)}</p>
            {ai.usage.length === 0 ? <p className="myso-knowledge-note">No AI credit usage is stored for this account yet.</p> : <ul>{ai.usage.map((row, index) => <li key={String(row.receipt_id ?? index)}><span>{typeof row.amount_mist === "string" ? `${count(row.amount_mist)} MIST` : "Amount unavailable"}</span><small>{typeof row.created_at === "string" ? new Date(row.created_at).toLocaleString() : "Time unavailable"}{typeof row.model_id === "string" && row.model_id ? ` · ${row.model_id}` : ""}{typeof row.tool_id === "string" && row.tool_id ? ` · ${row.tool_id}` : ""}</small></li>)}</ul>}
        </>}
    </section>;
}
