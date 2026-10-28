"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = {
    taskId: string; status: number; amountMist: string;
    buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string;
    sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string;
};
type Coin = { coinObjectId: string; coinType: string; balanceBaseUnits: string; version: string; digest: string; previousTransaction: string };
type CoinPage = { data: Coin[]; hasNextPage: boolean; nextCursor: string | null; maxActionSpendMist: string | null; notice: string };
type Submission = { taskId: string; digest: string };
type Receipt = { digest: string; taskId: string; caseId: string | null; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };

function sameId(left: string, right: string) {
    return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { "content-type": "application/json", ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The task dispute request failed.");
    return data as T;
}

export function MySoTaskDispute({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: boolean; onUpdated: () => void }) {
    const [coins, setCoins] = useState<Coin[]>([]);
    const [coinCursor, setCoinCursor] = useState<string | null>(null);
    const [hasMoreCoins, setHasMoreCoins] = useState(false);
    const [selectedCoinId, setSelectedCoinId] = useState("");
    const [coinLoading, setCoinLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submission, setSubmission] = useState<Submission | null>(null);
    const [receipt, setReceipt] = useState<Receipt | null>(null);
    const [receiptLoading, setReceiptLoading] = useState(false);
    const [error, setError] = useState("");

    const role = useMemo(() => {
        if (!scope) return null;
        if (sameId(task.buyerPrincipal, scope.owner) && sameId(task.buyerMemoryAccountId, scope.accountId) && (!task.buyerAgentId || sameId(task.buyerAgentId, scope.agentId))) return "buyer";
        if (sameId(task.sellerPrincipal, scope.owner) && sameId(task.sellerMemoryAccountId, scope.accountId) && sameId(task.sellerAgentId, scope.agentId)) return "seller";
        return null;
    }, [scope, task]);
    const requiredFee = useMemo(() => {
        if (!/^(0|[1-9][0-9]*)$/.test(task.amountMist)) return null;
        const fee = BigInt(task.amountMist) * 300n / 10_000n;
        return fee < 100_000_000n ? 100_000_000n : fee > 50_000_000_000n ? 50_000_000_000n : fee;
    }, [task.amountMist]);
    const operationKey = selectedCoinId ? `myso-agents:task-dispute:${task.taskId}:${selectedCoinId}` : "";
    const selectedCoin = coins.find((coin) => coin.coinObjectId === selectedCoinId) ?? null;
    const enoughBalance = !!selectedCoin && requiredFee !== null && BigInt(selectedCoin.balanceBaseUnits) >= requiredFee;

    useEffect(() => {
        const digest = sessionStorage.getItem(`myso-agents:task-dispute:${task.taskId}:digest`);
        if (digest) setSubmission({ taskId: task.taskId, digest });
        else { setSubmission(null); setReceipt(null); }
    }, [task.taskId]);

    async function loadCoins(cursor?: string) {
        setCoinLoading(true); setError("");
        try {
            const query = new URLSearchParams({ limit: "50" }); if (cursor) query.set("cursor", cursor);
            const page = await api<CoinPage>(`task-market/funding-coins?${query}`);
            setCoins((current) => cursor ? [...current, ...page.data] : page.data);
            setCoinCursor(page.nextCursor); setHasMoreCoins(page.hasNextPage);
            setSelectedCoinId((current) => current || page.data.find((coin) => requiredFee !== null && BigInt(coin.balanceBaseUnits) >= requiredFee)?.coinObjectId || page.data[0]?.coinObjectId || "");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent-owned MYSO coins could not be loaded."); }
        finally { setCoinLoading(false); }
    }

    async function openDispute() {
        if (!role || !enabled || task.status !== 2 || !selectedCoin || !enoughBalance || !operationKey || submission) return;
        setSubmitting(true); setError("");
        const idempotencyKey = sessionStorage.getItem(operationKey) ?? crypto.randomUUID();
        sessionStorage.setItem(operationKey, idempotencyKey);
        try {
            const result = await api<{ submitted: true; transactionDigest: string; taskId: string }>(`tasks/${encodeURIComponent(task.taskId)}/dispute`, { method: "POST", body: JSON.stringify({ feeCoinId: selectedCoin.coinObjectId, idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !result.transactionDigest) throw new Error("The dispute response did not match this task.");
            const next = { taskId: task.taskId, digest: result.transactionDigest };
            sessionStorage.setItem(`myso-agents:task-dispute:${task.taskId}:digest`, next.digest); setSubmission(next);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The dispute could not be submitted; retry only with the same coin and pending request."); }
        finally { setSubmitting(false); }
    }

    async function verifyDispute() {
        if (!submission) return;
        setReceiptLoading(true); setError(""); setReceipt(null);
        try {
            const query = new URLSearchParams({ taskId: task.taskId });
            const result = await api<Receipt>(`task-dispute-receipts/${encodeURIComponent(submission.digest)}?${query}`);
            if (result.digest !== submission.digest || !sameId(result.taskId, task.taskId) || result.status === "finalized" && (!result.caseId || result.verification !== "finalized_task_disputed_and_jury_case_opened")) throw new Error("The dispute receipt does not match this task and jury case.");
            setReceipt(result);
            if (result.status === "finalized") { sessionStorage.removeItem(`myso-agents:task-dispute:${task.taskId}:digest`); onUpdated(); }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The dispute receipt could not be verified yet."); }
        finally { setReceiptLoading(false); }
    }

    if (task.status !== 2 || !role) return null;
    return <section className="myso-settlement-receipt" aria-label="Open a task dispute">
        <h3>Open a jury dispute</h3>
        <p>The task escrow is {role === "buyer" ? "held while the dispute is reviewed" : "held while the dispute is reviewed"}. The opener pays an estimated {requiredFee?.toString() ?? "—"} MIST case fee from an agent-owned MYSO coin; the other side must match the fee. The Move action rechecks the exact fee, task state, spend authority and jury roster.</p>
        {!submission && <>
            {coins.length === 0 ? <button type="button" className="myso-secondary" disabled={coinLoading||!enabled} onClick={() => void loadCoins()}>{coinLoading ? "Loading agent coins…" : "Load agent MYSO coins"}</button> : <>
                <label htmlFor={`dispute-coin-${task.taskId}`}>Agent MYSO fee coin</label>
                <select id={`dispute-coin-${task.taskId}`} value={selectedCoinId} onChange={(event) => setSelectedCoinId(event.target.value)} disabled={submitting}>
                    {coins.map((coin) => <option key={coin.coinObjectId} value={coin.coinObjectId}>{coin.coinObjectId.slice(0, 12)}… · {coin.balanceBaseUnits} MIST</option>)}
                </select>
                {hasMoreCoins&&coinCursor&&<button type="button" className="myso-text-button" disabled={coinLoading} onClick={()=>void loadCoins(coinCursor)}>{coinLoading?"Loading…":"Load more coins"}</button>}
                <button type="button" className="myso-secondary" disabled={submitting||!enabled||!enoughBalance} onClick={()=>void openDispute()}>{submitting?"Opening dispute…":"Pay fee and open dispute"}</button>
                {selectedCoin&&!enoughBalance&&<p className="myso-knowledge-note" role="alert">This coin does not cover the estimated case fee.</p>}
            </>}
        </>}
        {submission&&<><p className="myso-knowledge-note" role="status">Dispute transaction submitted. Wait for finality, then verify the task dispute and paired jury-case events. Transaction {submission.digest}</p><button type="button" className="myso-secondary" disabled={receiptLoading} onClick={()=>void verifyDispute()}>{receiptLoading?"Checking fullnode…":"Verify dispute receipt"}</button>{receipt&&<p className="myso-knowledge-note" role="status">{receipt.status==="finalized"?`Dispute and jury case ${receipt.caseId} verified.`:`Dispute receipt status: ${receipt.status.replaceAll("_"," ")}`}</p>}</>}
        {error&&<p className="myso-error" role="alert">{error}</p>}
        <p className="myso-plan-note">The on-chain fee is 300 bps of escrow, bounded from 100,000,000 to 50,000,000,000 MIST. This estimate uses the current package constants; on-chain execution is authoritative. If the roster is not ready, the action will fail without opening a case.</p>
    </section>;
}
