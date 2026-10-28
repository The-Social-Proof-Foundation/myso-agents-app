"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = { taskId: string; status: number; buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string; sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string };
type Dispute = { taskId: string; caseId: string; openedByRole: number; state: number; feeEachMist: string; buyerPaidMist: string; sellerPaidMist: string; openedAtMs: number; caseUndrawn: boolean };
type Coin = { coinObjectId: string; balanceBaseUnits: string };
type CoinPage = { data: Coin[]; hasNextPage: boolean; nextCursor: string | null };
type Receipt = { digest: string; taskId: string; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };

function sameId(left: string, right: string) { return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0"); }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The dispute fee request failed.");
    return data as T;
}

export function MySoTaskDisputeResponse({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: (action: string) => boolean; onUpdated: () => void }) {
    const [dispute, setDispute] = useState<Dispute | null>(null);
    const [coins, setCoins] = useState<Coin[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [coinId, setCoinId] = useState("");
    const [digest, setDigest] = useState("");
    const [receipt, setReceipt] = useState<Receipt | null>(null);
    const [cancelDigest, setCancelDigest] = useState("");
    const [cancelReceipt, setCancelReceipt] = useState<Receipt | null>(null);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const role = useMemo(() => {
        if (!scope) return 0;
        if (sameId(task.buyerPrincipal, scope.owner) && sameId(task.buyerMemoryAccountId, scope.accountId) && (!task.buyerAgentId || sameId(task.buyerAgentId, scope.agentId))) return 1;
        if (sameId(task.sellerPrincipal, scope.owner) && sameId(task.sellerMemoryAccountId, scope.accountId) && sameId(task.sellerAgentId, scope.agentId)) return 2;
        return 0;
    }, [scope, task]);
    const requiredFee = dispute && /^(0|[1-9][0-9]*)$/.test(dispute.feeEachMist) ? BigInt(dispute.feeEachMist) : null;
    const selectedCoin = coins.find(coin => coin.coinObjectId === coinId) ?? null;
    const enough = !!selectedCoin && requiredFee !== null && BigInt(selectedCoin.balanceBaseUnits) >= requiredFee;
    const ownPaid = dispute ? role === 1 ? dispute.buyerPaidMist : dispute.sellerPaidMist : "";
    const otherPaid = dispute ? role === 1 ? dispute.sellerPaidMist : dispute.buyerPaidMist : "";
    const canMatch = task.status === 6 && role !== 0 && !!dispute && dispute.state === 1 && dispute.openedByRole !== role && ownPaid === "0" && otherPaid === dispute.feeEachMist;
    const canCancel = task.status === 6 && role !== 0 && !!dispute && dispute.state === 1 && dispute.openedByRole === role && dispute.caseUndrawn;

    useEffect(() => {
        if (task.status !== 6 || role === 0) { setDispute(null); return; }
        let active = true;
        setLoading(true); setError("");
        void api<Dispute>(`tasks/${encodeURIComponent(task.taskId)}/dispute`).then(value => {
            if (!sameId(value.taskId, task.taskId) || !/^0x[0-9a-fA-F]{1,64}$/.test(value.caseId)) throw new Error("Dispute details do not match this task.");
            if (active) setDispute(value);
        }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Dispute details could not be loaded."); })
            .finally(() => { if (active) setLoading(false); });
        const saved = sessionStorage.getItem(`myso-agents:task-dispute:${task.taskId}:response-digest`);
        if (saved) setDigest(saved);
        const savedCancel = sessionStorage.getItem(`myso-agents:task-dispute:${task.taskId}:cancel-digest`);
        if (savedCancel) setCancelDigest(savedCancel);
        return () => { active = false; };
    }, [role, task.status, task.taskId]);

    async function loadCoins(next?: string) {
        setLoading(true); setError("");
        try {
            const query = new URLSearchParams({ limit: "50" }); if (next) query.set("cursor", next);
            const page = await api<CoinPage>(`task-market/funding-coins?${query}`);
            setCoins(current => next ? [...current, ...page.data] : page.data); setCursor(page.nextCursor); setHasMore(page.hasNextPage);
            setCoinId(current => current || page.data.find(coin => requiredFee !== null && BigInt(coin.balanceBaseUnits) >= requiredFee)?.coinObjectId || page.data[0]?.coinObjectId || "");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent-owned MYSO coins could not be loaded."); }
        finally { setLoading(false); }
    }

    async function respond() {
        if (!canMatch || !enabled("task_respond_dispute") || !selectedCoin || !enough || submitting || !dispute) return;
        setSubmitting(true); setError("");
        const key = `myso-agents:task-dispute:${task.taskId}:response:${selectedCoin.coinObjectId}`;
        const idempotencyKey = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, idempotencyKey);
        try {
            const result = await api<{ taskId: string; caseId: string; transactionDigest: string }>(`tasks/${encodeURIComponent(task.taskId)}/dispute/respond`, { method: "POST", body: JSON.stringify({ feeCoinId: selectedCoin.coinObjectId, idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !sameId(result.caseId, dispute.caseId) || !result.transactionDigest) throw new Error("The response transaction does not match this dispute.");
            setDigest(result.transactionDigest); sessionStorage.setItem(`myso-agents:task-dispute:${task.taskId}:response-digest`, result.transactionDigest);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The matching fee could not be submitted."); }
        finally { setSubmitting(false); }
    }

    async function verify() {
        if (!digest || checking) return;
        setChecking(true); setError("");
        try {
            const query = new URLSearchParams({ taskId: task.taskId });
            const result = await api<Receipt>(`task-dispute-response-receipts/${encodeURIComponent(digest)}?${query}`);
            if (result.digest !== digest || !sameId(result.taskId, task.taskId) || result.status === "finalized" && result.verification !== "finalized_task_dispute_fee_matched_event") throw new Error("The fee receipt did not match this task.");
            setReceipt(result);
            if (result.status === "finalized") { sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:response-digest`); onUpdated(); }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The matching-fee receipt could not be verified yet."); }
        finally { setChecking(false); }
    }

    async function cancelDispute() {
        if (!canCancel || !enabled("task_cancel_dispute") || submitting) return;
        setSubmitting(true); setError("");
        const key = `myso-agents:task-dispute:${task.taskId}:cancel-idempotency`;
        const idempotencyKey = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, idempotencyKey);
        try {
            const result = await api<{ taskId: string; caseId: string; transactionDigest: string }>(`tasks/${encodeURIComponent(task.taskId)}/dispute/cancel`, { method: "POST", body: JSON.stringify({ idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !dispute || !sameId(result.caseId, dispute.caseId) || !result.transactionDigest) throw new Error("The cancellation response did not match this jury case.");
            setCancelDigest(result.transactionDigest); sessionStorage.setItem(`myso-agents:task-dispute:${task.taskId}:cancel-digest`, result.transactionDigest);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The dispute could not be withdrawn."); }
        finally { setSubmitting(false); }
    }

    async function verifyCancel() {
        if (!cancelDigest || checking) return;
        setChecking(true); setError("");
        try {
            const query = new URLSearchParams({ taskId: task.taskId });
            const result = await api<Receipt & { caseId: string }>(`task-dispute-cancel-receipts/${encodeURIComponent(cancelDigest)}?${query}`);
            if (result.digest !== cancelDigest || !sameId(result.taskId, task.taskId) || !dispute || !sameId(result.caseId, dispute.caseId) || result.status === "finalized" && result.verification !== "finalized_task_dispute_cancelled_and_jury_case_cancelled") throw new Error("The cancellation receipt did not match this task and case.");
            setCancelReceipt(result);
            if (result.status === "finalized") { sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:cancel-digest`); sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:cancel-idempotency`); onUpdated(); }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The dispute cancellation receipt could not be verified yet."); }
        finally { setChecking(false); }
    }

    if (task.status !== 6 || !role) return null;
    return <section className="myso-settlement-receipt" aria-label="Match task dispute fee">
        <h3>Match the jury case fee</h3>
        {dispute ? <p>Case {dispute.caseId} requires {dispute.feeEachMist} MIST from the other party. The opening side is {dispute.openedByRole === 1 ? "the buyer" : "the seller"}; this matching payment must arrive before jury selection.</p> : <p>{loading ? "Loading the current dispute fee and case…" : "Dispute state is unavailable."}</p>}
        {canMatch && !digest && <>
            {coins.length === 0 ? <button type="button" className="myso-secondary" disabled={loading || !enabled("task_respond_dispute")} onClick={() => void loadCoins()}>{loading ? "Loading agent coins…" : "Load agent MYSO coins"}</button> : <>
                <label htmlFor={`dispute-response-coin-${task.taskId}`}>Agent MYSO fee coin</label>
                <select id={`dispute-response-coin-${task.taskId}`} value={coinId} onChange={event => setCoinId(event.target.value)} disabled={submitting}>
                    {coins.map(coin => <option key={coin.coinObjectId} value={coin.coinObjectId}>{coin.coinObjectId.slice(0, 12)}… · {coin.balanceBaseUnits} MIST</option>)}
                </select>
                {hasMore && cursor && <button type="button" className="myso-text-button" disabled={loading} onClick={() => void loadCoins(cursor)}>{loading ? "Loading…" : "Load more coins"}</button>}
                <button type="button" className="myso-secondary" disabled={submitting || !enabled("task_respond_dispute") || !enough} onClick={() => void respond()}>{submitting ? "Matching fee…" : "Pay matching fee"}</button>
                {selectedCoin && !enough && <p className="myso-knowledge-note" role="alert">This agent-owned coin does not cover the exact case fee.</p>}
            </>}
        </>}
        {canMatch && digest && <><p className="myso-knowledge-note" role="status">Matching-fee transaction submitted. Verify the finalized `TaskDisputeFeePaid` event before treating the jury case as funded. Transaction {digest}</p><button type="button" className="myso-secondary" disabled={checking} onClick={() => void verify()}>{checking ? "Checking fullnode…" : "Verify matching-fee receipt"}</button></>}
        {canCancel && !cancelDigest && <div><p className="myso-knowledge-note">As the party who opened this dispute, you may withdraw it before the first jury draw. The task returns to delivered and its settlement deadline is rebased.</p><button type="button" className="myso-secondary" disabled={!enabled("task_cancel_dispute") || submitting} onClick={() => void cancelDispute()}>{submitting ? "Withdrawing dispute…" : "Withdraw before jury selection"}</button></div>}
        {cancelDigest && <><p className="myso-knowledge-note" role="status">Dispute withdrawal submitted. Verify the task and paired jury cancellation events. Transaction {cancelDigest}</p><button type="button" className="myso-secondary" disabled={checking} onClick={() => void verifyCancel()}>{checking ? "Checking fullnode…" : "Verify cancellation receipt"}</button></>}
        {dispute && !canMatch && !digest && <p className="myso-knowledge-note">This case is not waiting for your payment, or jury selection has already started.</p>}
        {receipt && <p className="myso-knowledge-note" role="status">{receipt.status === "finalized" ? "The matching payment is finalized and verified." : `Receipt status: ${receipt.status.replaceAll("_", " ")}`}</p>}
        {cancelReceipt && <p className="myso-knowledge-note" role="status">{cancelReceipt.status === "finalized" ? "The dispute and jury case cancellations are finalized and verified." : `Receipt status: ${cancelReceipt.status.replaceAll("_", " ")}`}</p>}
        {error && <p className="myso-error" role="alert">{error}</p>}
    </section>;
}
