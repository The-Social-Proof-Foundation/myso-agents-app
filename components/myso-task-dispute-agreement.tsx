"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = { taskId: string; status: number; buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string; sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string };
type Dispute = { taskId: string; caseId: string; state: number; agreementProposer: number; agreementOutcome: number | null };
type Action = "propose" | "accept" | "clear";
type Pending = { taskId: string; action: Action; outcome: number | null; digest: string };
type Receipt = { digest: string; taskId: string; action: Action; outcome: number | null; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };
const outcomeLabel = ["Pay seller in full", "Refund buyer in full", "Split escrow 50/50"];
function sameId(left: string, right: string) { return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0"); }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The dispute agreement request failed.");
    return data as T;
}

export function MySoTaskDisputeAgreement({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: (action: string) => boolean; onUpdated: () => void }) {
    const [dispute, setDispute] = useState<Dispute | null>(null);
    const [outcome, setOutcome] = useState(2);
    const [pending, setPending] = useState<Pending | null>(null);
    const [receipt, setReceipt] = useState<Receipt | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const role = useMemo(() => {
        if (!scope) return 0;
        if (sameId(task.buyerPrincipal, scope.owner) && sameId(task.buyerMemoryAccountId, scope.accountId) && (!task.buyerAgentId || sameId(task.buyerAgentId, scope.agentId))) return 1;
        if (sameId(task.sellerPrincipal, scope.owner) && sameId(task.sellerMemoryAccountId, scope.accountId) && sameId(task.sellerAgentId, scope.agentId)) return 2;
        return 0;
    }, [scope, task]);
    const proposer = dispute?.agreementProposer ?? 0;
    const pendingOutcome = dispute?.agreementOutcome ?? null;
    const canPropose = !!dispute && dispute.state === 1 && (proposer === 0 || proposer === role) && role !== 0;
    const canAccept = !!dispute && dispute.state === 1 && pendingOutcome !== null && proposer !== 0 && proposer !== role && role !== 0;
    const canClear = !!dispute && dispute.state === 1 && proposer !== 0 && role !== 0;

    useEffect(() => {
        if (task.status !== 6 || role === 0) { setDispute(null); return; }
        let active = true;
        setLoading(true); setError("");
        void api<Dispute>(`tasks/${encodeURIComponent(task.taskId)}/dispute`).then(value => {
            if (!sameId(value.taskId, task.taskId) || !/^0x[0-9a-fA-F]{1,64}$/.test(value.caseId)) throw new Error("The agreement state does not match this task.");
            if (active) { setDispute(value); if (value.agreementOutcome !== null) setOutcome(value.agreementOutcome); }
        }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "The agreement state could not be loaded."); })
            .finally(() => { if (active) setLoading(false); });
        const saved = sessionStorage.getItem(`myso-agents:task-dispute:${task.taskId}:agreement-pending`);
        if (saved) {
            try { const value = JSON.parse(saved) as Pending; if (value.taskId === task.taskId) setPending(value); }
            catch { sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:agreement-pending`); }
        }
        return () => { active = false; };
    }, [role, task.status, task.taskId]);

    async function submit(action: Action, selectedOutcome: number | null = null) {
        if (!dispute || role === 0 || busy || action === "propose" && !canPropose || action === "accept" && !canAccept || action === "clear" && !canClear || action === "propose" && (selectedOutcome === null || selectedOutcome < 0 || selectedOutcome > 2)) return;
        const tool = ({ propose: "task_propose_dispute_settlement", accept: "task_accept_dispute_settlement", clear: "task_clear_dispute_settlement" } as const)[action];
        if (!enabled(tool)) return;
        setBusy(true); setError("");
        const key = `myso-agents:task-dispute:${task.taskId}:agreement:${action}:${selectedOutcome ?? "none"}`;
        const idempotencyKey = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, idempotencyKey);
        try {
            const result = await api<{ taskId: string; caseId: string; action: Action; outcome: number | null; transactionDigest: string }>(`tasks/${encodeURIComponent(task.taskId)}/dispute/settlement`, { method: "POST", body: JSON.stringify({ action, ...(action === "propose" ? { outcome: selectedOutcome } : {}), idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !sameId(result.caseId, dispute.caseId) || result.action !== action || result.outcome !== selectedOutcome || !result.transactionDigest) throw new Error("The agreement transaction did not match this task and case.");
            const next = { taskId: task.taskId, action, outcome: selectedOutcome, digest: result.transactionDigest };
            setPending(next); sessionStorage.setItem(`myso-agents:task-dispute:${task.taskId}:agreement-pending`, JSON.stringify(next));
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The agreement action could not be submitted."); }
        finally { setBusy(false); }
    }

    async function verify() {
        if (!pending || busy) return;
        setBusy(true); setError("");
        try {
            const query = new URLSearchParams({ taskId: task.taskId, action: pending.action });
            if (pending.outcome !== null) query.set("outcome", String(pending.outcome));
            const result = await api<Receipt>(`task-dispute-agreement-receipts/${encodeURIComponent(pending.digest)}?${query}`);
            if (result.digest !== pending.digest || !sameId(result.taskId, task.taskId) || result.action !== pending.action || result.outcome !== pending.outcome || result.status === "finalized" && !result.verification.startsWith("finalized_")) throw new Error("The agreement receipt did not match the submitted action.");
            setReceipt(result);
            if (result.status === "finalized") {
                sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:agreement-pending`);
                sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:agreement:${pending.action}:${pending.outcome ?? "none"}`);
                setPending(null); onUpdated();
            }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The agreement receipt could not be verified yet."); }
        finally { setBusy(false); }
    }

    if (task.status !== 6 || !role) return null;
    return <section className="myso-settlement-receipt" aria-label="Task dispute settlement agreement">
        <h3>Resolve by agreement</h3>
        <p>Either party can propose a fixed escrow outcome. The other party accepts to execute it on chain; either side can clear a pending proposal. A split does not add task reputation.</p>
        {loading && <p className="myso-knowledge-note" role="status">Loading current proposal…</p>}
        {dispute && <p className="myso-knowledge-note" role="status">{proposer === 0 ? "No agreement proposal is pending." : `${proposer === 1 ? "Buyer" : "Seller"} proposed: ${outcomeLabel[pendingOutcome ?? 0]}.`}</p>}
        {!pending && canPropose && <div><label htmlFor={`dispute-outcome-${task.taskId}`}>Proposed escrow outcome</label><select id={`dispute-outcome-${task.taskId}`} value={outcome} onChange={event => setOutcome(Number(event.target.value))} disabled={busy}><option value={0}>{outcomeLabel[0]}</option><option value={1}>{outcomeLabel[1]}</option><option value={2}>{outcomeLabel[2]}</option></select><button type="button" className="myso-secondary" disabled={busy || !enabled("task_propose_dispute_settlement")} onClick={() => void submit("propose", outcome)}>{proposer === role ? "Update my proposal" : "Propose outcome"}</button></div>}
        {!pending && canAccept && <button type="button" className="myso-secondary" disabled={busy || !enabled("task_accept_dispute_settlement")} onClick={() => void submit("accept", pendingOutcome)}>Accept and execute {(outcomeLabel[pendingOutcome ?? 0] ?? "the proposed outcome").toLowerCase()}</button>}
        {!pending && canClear && <button type="button" className="myso-secondary" disabled={busy || !enabled("task_clear_dispute_settlement")} onClick={() => void submit("clear")}>Clear pending proposal</button>}
        {pending && <><p className="myso-knowledge-note" role="status">{pending.action === "propose" ? `Proposal submitted: ${outcomeLabel[pending.outcome ?? 0]}.` : pending.action === "accept" ? "Agreement acceptance submitted; escrow payout is part of this transaction." : "Proposal clearing submitted."} Verify transaction {pending.digest} before treating the state as changed.</p><button type="button" className="myso-secondary" disabled={busy} onClick={() => void verify()}>{busy ? "Checking fullnode…" : "Verify agreement receipt"}</button></>}
        {receipt && <p className="myso-knowledge-note" role="status">{receipt.status === "finalized" ? "The dispute agreement event is finalized and verified." : `Receipt status: ${receipt.status.replaceAll("_", " ")}`}</p>}
        {error && <p className="myso-error" role="alert">{error}</p>}
    </section>;
}
