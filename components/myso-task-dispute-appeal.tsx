"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = { taskId: string; status: number; buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string; sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string };
type Round = { round: number; acceptDeadlineMs: string; commitDeadlineMs: string | null; revealDeadlineMs: string | null; tally: string[] | null; abstain: string | null; revealed: string | null; decisive: boolean | null; leading: number | null; appealDeadlineMs: string | null };
type CaseDetail = { state: number; stage: number; finalOutcome: number | null; appealable: boolean; currentRound: number; roundSizes: number[]; appealsUsed: number; failedAppeal: boolean; participants: string | null; evidenceDeadlineMs: string; finalizedAtMs: string | null; cancelledAtMs: string | null; rounds: Round[] };
type Dispute = { taskId: string; caseId: string; state: number; feeEachMist: string; case: CaseDetail | null };
type Coin = { coinObjectId: string; balanceBaseUnits: string };
type CoinPage = { data: Coin[]; hasNextPage: boolean; nextCursor: string | null };
type Pending = { digest: string; round: number; priorOutcome: number };
type Receipt = Pending & { digest: string; taskId: string; caseId: string; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };
const outcomeLabel = ["Pay seller", "Refund buyer", "Split escrow"];
const caseStateLabel: Record<number, string> = { 1: "Evidence gathering", 2: "Awaiting jury selection", 3: "Jury selection", 4: "Jury voting", 5: "Provisional outcome", 6: "Finalized", 7: "Could not be decided", 8: "Cancelled" };
function sameId(left: string, right: string) { return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0"); }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The appeal request failed.");
    return data as T;
}

export function MySoTaskDisputeAppeal({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: (action: string) => boolean; onUpdated: () => void }) {
    const [dispute, setDispute] = useState<Dispute | null>(null);
    const [coins, setCoins] = useState<Coin[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [coinId, setCoinId] = useState("");
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
    const current = dispute?.case?.rounds.find(row => row.round === dispute.case?.currentRound) ?? null;
    const caseInfo = dispute?.case ?? null;
    const now = Date.now();
    const juryPhase = !caseInfo ? "" : caseInfo.state === 1 ? Number(caseInfo.evidenceDeadlineMs) > now ? "Evidence can still be submitted" : "Evidence window ended; jury selection is pending" : caseInfo.state === 2 ? "Jury selection is pending" : caseInfo.state === 3 ? "Jurors are being selected" : caseInfo.state === 4 ? !current?.commitDeadlineMs || Number(current.commitDeadlineMs) > now ? "Jury commitment phase" : !current.revealDeadlineMs || Number(current.revealDeadlineMs) > now ? "Jury reveal phase" : "Waiting for the round tally" : caseInfo.state === 5 ? "The round has a provisional outcome" : caseStateLabel[caseInfo.state] ?? "Jury case status unavailable";
    const outcome = current?.leading ?? null;
    const fee = dispute && /^(0|[1-9][0-9]*)$/.test(dispute.feeEachMist) ? BigInt(dispute.feeEachMist) * 2n : null;
    const selectedCoin = coins.find(coin => coin.coinObjectId === coinId) ?? null;
    const enough = !!selectedCoin && fee !== null && /^(0|[1-9][0-9]*)$/.test(selectedCoin.balanceBaseUnits) && BigInt(selectedCoin.balanceBaseUnits) >= fee;
    const eligibleRole = outcome === 0 ? 1 : outcome === 1 ? 2 : outcome === 2 ? role : 0;
    const deadline = current?.appealDeadlineMs ? Number(current.appealDeadlineMs) : 0;
    const canAppeal = task.status === 6 && role !== 0 && !!dispute?.case?.appealable && dispute.state === 1 && outcome !== null && role === eligibleRole && dispute.case.currentRound + 1 < dispute.case.roundSizes.length && deadline > Date.now();
    const keyPrefix = `myso-agents:task-dispute:${task.taskId}:appeal`;

    useEffect(() => {
        if (![3, 4, 6].includes(task.status) || role === 0) { setDispute(null); return; }
        let active = true;
        setLoading(true); setError("");
        void api<Dispute>(`tasks/${encodeURIComponent(task.taskId)}/dispute`).then(value => {
            if (!sameId(value.taskId, task.taskId) || !/^0x[0-9a-fA-F]{1,64}$/.test(value.caseId)) throw new Error("Appeal details do not match this task.");
            if (active) setDispute(value);
        }).catch(reason => { if (active && task.status === 6) setError(reason instanceof Error ? reason.message : "Appeal details could not be loaded."); })
            .finally(() => { if (active) setLoading(false); });
        const saved = sessionStorage.getItem(`${keyPrefix}:pending`);
        if (saved) { try { const value = JSON.parse(saved) as Pending; if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value.digest)) setPending(value); } catch { sessionStorage.removeItem(`${keyPrefix}:pending`); } }
        return () => { active = false; };
    }, [role, task.status, task.taskId]);

    async function loadCoins(next?: string) {
        setLoading(true); setError("");
        try {
            const query = new URLSearchParams({ limit: "50" }); if (next) query.set("cursor", next);
            const page = await api<CoinPage>(`task-market/funding-coins?${query}`);
            setCoins(rows => next ? [...rows, ...page.data] : page.data); setCursor(page.nextCursor); setHasMore(page.hasNextPage);
            setCoinId(value => value || page.data.find(coin => fee !== null && BigInt(coin.balanceBaseUnits) >= fee)?.coinObjectId || page.data[0]?.coinObjectId || "");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent-owned MYSO coins could not be loaded."); }
        finally { setLoading(false); }
    }

    async function appeal() {
        if (!canAppeal || !enabled("task_appeal_dispute") || !selectedCoin || !enough || !dispute?.case || !current || outcome === null || busy) return;
        setBusy(true); setError("");
        const idempotencyKey = sessionStorage.getItem(`${keyPrefix}:idempotency`) ?? crypto.randomUUID(); sessionStorage.setItem(`${keyPrefix}:idempotency`, idempotencyKey);
        try {
            const result = await api<{ taskId: string; caseId: string; transactionDigest: string; round: number; priorOutcome: number }>(`tasks/${encodeURIComponent(task.taskId)}/dispute/appeal`, { method: "POST", body: JSON.stringify({ feeCoinId: selectedCoin.coinObjectId, idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !sameId(result.caseId, dispute.caseId) || result.round !== dispute.case.currentRound || result.priorOutcome !== outcome || !result.transactionDigest) throw new Error("The appeal transaction did not match the current jury round.");
            const next = { digest: result.transactionDigest, round: result.round, priorOutcome: result.priorOutcome };
            setPending(next); sessionStorage.setItem(`${keyPrefix}:pending`, JSON.stringify(next));
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The appeal could not be submitted."); }
        finally { setBusy(false); }
    }

    async function verify() {
        if (!pending || !dispute || busy) return;
        setBusy(true); setError("");
        try {
            const query = new URLSearchParams({ taskId: task.taskId, caseId: dispute.caseId, round: String(pending.round), priorOutcome: String(pending.priorOutcome) });
            const result = await api<Receipt>(`task-dispute-appeal-receipts/${encodeURIComponent(pending.digest)}?${query}`);
            if (result.digest !== pending.digest || !sameId(result.taskId, task.taskId) || !sameId(result.caseId, dispute.caseId) || result.round !== pending.round || result.priorOutcome !== pending.priorOutcome || result.status === "finalized" && result.verification !== "finalized_task_appeal_fee_and_case_event") throw new Error("The appeal receipt did not match this case and round.");
            setReceipt(result);
            if (result.status === "finalized") { sessionStorage.removeItem(`${keyPrefix}:pending`); sessionStorage.removeItem(`${keyPrefix}:idempotency`); setPending(null); onUpdated(); }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The appeal receipt could not be verified yet."); }
        finally { setBusy(false); }
    }

    if (!role || task.status !== 6 && !dispute) return null;
    return <section className="myso-settlement-receipt" aria-label="Appeal task dispute">
        <h3>Jury case status</h3>
        {caseInfo && <div className="myso-knowledge-note" aria-live="polite">
            <p><strong>Jury case status:</strong> {caseStateLabel[caseInfo.state] ?? "Unknown"} · {juryPhase}</p>
            <p>Round {caseInfo.rounds.length ? caseInfo.currentRound + 1 : 0} of {caseInfo.roundSizes.length} · {caseInfo.appealsUsed} appeal(s) used{caseInfo.failedAppeal ? " · a prior appeal did not change the outcome" : ""}</p>
            {caseInfo.participants !== null && <p>Jury members: {caseInfo.participants}</p>}
            {current?.tally && <p>Current tally: {current.tally.map((votes, index) => `${outcomeLabel[index] ?? `Outcome ${index}`} ${votes}`).join(" · ")}{current.abstain !== null ? ` · Abstain ${current.abstain}` : ""}{current.revealed !== null ? ` · ${current.revealed} revealed` : ""}</p>}
            {current?.leading !== null && current?.leading !== undefined && <p>Provisional outcome: {outcomeLabel[current.leading] ?? "Unknown"}{current.decisive === false ? " (not decisive)" : ""}</p>}
            {caseInfo.state === 6 && caseInfo.finalOutcome !== null && <p><strong>Final outcome: {outcomeLabel[caseInfo.finalOutcome] ?? "Unknown"}</strong>{caseInfo.finalizedAtMs ? ` · finalized ${new Date(Number(caseInfo.finalizedAtMs)).toLocaleString()}` : ""}</p>}
            {caseInfo.state === 8 && caseInfo.cancelledAtMs && <p>Cancelled {new Date(Number(caseInfo.cancelledAtMs)).toLocaleString()}.</p>}
            {caseInfo.rounds.map(row => <p key={row.round}>Round {row.round + 1}: {row.revealed ?? "—"} revealed, {row.abstain ?? "—"} abstained{row.leading !== null ? ` · leading ${outcomeLabel[row.leading] ?? "Unknown"}` : ""}{row.appealDeadlineMs ? ` · appeal deadline ${new Date(Number(row.appealDeadlineMs)).toLocaleString()}` : ""}</p>)}
        </div>}
        {!dispute && <p>{loading ? "Loading the current jury round…" : "Jury round details are unavailable."}</p>}
        {dispute && current && <p>The provisional outcome is {outcomeLabel[outcome ?? 0]}. {current.appealDeadlineMs ? `Appeals close at ${new Date(Number(current.appealDeadlineMs)).toLocaleString()}.` : "The appeal window is closed."} An appeal costs {fee?.toString() ?? "—"} MIST.</p>}
        {canAppeal && !pending && <>
            {coins.length === 0 ? <button type="button" className="myso-secondary" disabled={loading || !enabled("task_appeal_dispute")} onClick={() => void loadCoins()}>{loading ? "Loading agent coins…" : "Load agent MYSO coins"}</button> : <>
                <label htmlFor={`dispute-appeal-coin-${task.taskId}`}>Agent MYSO appeal-fee coin</label>
                <select id={`dispute-appeal-coin-${task.taskId}`} value={coinId} onChange={event => setCoinId(event.target.value)} disabled={busy}>{coins.map(coin => <option key={coin.coinObjectId} value={coin.coinObjectId}>{coin.coinObjectId.slice(0, 12)}… · {coin.balanceBaseUnits} MIST</option>)}</select>
                {hasMore && cursor && <button type="button" className="myso-text-button" disabled={loading} onClick={() => void loadCoins(cursor)}>{loading ? "Loading…" : "Load more coins"}</button>}
                <button type="button" className="myso-secondary" disabled={busy || !enabled("task_appeal_dispute") || !enough} onClick={() => void appeal()}>{busy ? "Submitting appeal…" : "Appeal this outcome"}</button>
                {selectedCoin && !enough && <p className="myso-knowledge-note" role="alert">This coin does not cover the appeal fee.</p>}
            </>}
        </>}
        {pending && <><p className="myso-knowledge-note" role="status">Appeal submitted for round {pending.round + 1} of {outcomeLabel[pending.priorOutcome]}. Verify the finalized fee and jury events. Transaction {pending.digest}</p><button type="button" className="myso-secondary" disabled={busy} onClick={() => void verify()}>{busy ? "Checking fullnode…" : "Verify appeal receipt"}</button></>}
        {dispute && !canAppeal && !pending && <p className="myso-knowledge-note">This account cannot appeal the current provisional outcome, the window has closed, or no further jury round is configured.</p>}
        {receipt && <p className="myso-knowledge-note" role="status">{receipt.status === "finalized" ? "The appeal and matching fee are finalized and verified." : `Receipt status: ${receipt.status.replaceAll("_", " ")}`}</p>}
        {error && <p className="myso-error" role="alert">{error}</p>}
    </section>;
}
