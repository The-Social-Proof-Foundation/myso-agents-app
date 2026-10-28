"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = { taskId: string; status: number; refundProposer: number; refundProposedAtMs: number | null; buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string; sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string };
type RefundAction = "propose" | "accept" | "reject" | "withdraw";
type Submission = { taskId: string; action: RefundAction; digest: string };
type Receipt = { digest: string; taskId: string; action: RefundAction; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };

function sameId(left: string, right: string) {
    return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The refund request failed.");
    return data as T;
}

const labels: Record<RefundAction, string> = { propose: "Propose a full refund", accept: "Accept refund and return escrow", reject: "Reject refund proposal", withdraw: "Withdraw my refund proposal" };

export function MySoTaskRefund({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: (action: string) => boolean; onUpdated: () => void }) {
    const [submission, setSubmission] = useState<Submission | null>(null);
    const [receipt, setReceipt] = useState<Receipt | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const role = useMemo(() => {
        if (!scope) return 0;
        if (sameId(task.buyerPrincipal, scope.owner) && sameId(task.buyerMemoryAccountId, scope.accountId) && (!task.buyerAgentId || sameId(task.buyerAgentId, scope.agentId))) return 1;
        if (sameId(task.sellerPrincipal, scope.owner) && sameId(task.sellerMemoryAccountId, scope.accountId) && sameId(task.sellerAgentId, scope.agentId)) return 2;
        return 0;
    }, [scope, task]);
    const pendingAction = task.refundProposer === 0 ? null : task.refundProposer === 1 ? "buyer" : "seller";

    useEffect(() => {
        const raw = sessionStorage.getItem(`myso-agents:task-refund:${task.taskId}:pending`);
        if (!raw) { setSubmission(null); setReceipt(null); return; }
        try {
            const saved = JSON.parse(raw) as Submission;
            if (saved.taskId === task.taskId && ["propose", "accept", "reject", "withdraw"].includes(saved.action) && typeof saved.digest === "string") setSubmission(saved);
            else sessionStorage.removeItem(`myso-agents:task-refund:${task.taskId}:pending`);
        } catch { sessionStorage.removeItem(`myso-agents:task-refund:${task.taskId}:pending`); }
    }, [task.taskId]);

    async function submit(action: RefundAction) {
        if (!role || !enabled(`task_${action}_refund`) || task.status !== 2 || busy) return;
        setBusy(true); setError("");
        const key = `myso-agents:task-refund:${task.taskId}:${action}:idempotency`;
        const idempotencyKey = sessionStorage.getItem(key) ?? crypto.randomUUID();
        sessionStorage.setItem(key, idempotencyKey);
        try {
            const result = await api<{ submitted: true; transactionDigest: string; taskId: string; action: RefundAction }>(`tasks/${encodeURIComponent(task.taskId)}/refund`, { method: "POST", body: JSON.stringify({ action, idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || result.action !== action || !result.transactionDigest) throw new Error("The refund response did not match this task and action.");
            const pending = { taskId: task.taskId, action, digest: result.transactionDigest };
            sessionStorage.setItem(`myso-agents:task-refund:${task.taskId}:pending`, JSON.stringify(pending));
            setSubmission(pending); setReceipt(null);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The refund action could not be submitted. Retry only with the same action."); }
        finally { setBusy(false); }
    }

    async function verify() {
        if (!submission || busy) return;
        setBusy(true); setError(""); setReceipt(null);
        try {
            const query = new URLSearchParams({ taskId: task.taskId, action: submission.action });
            const result = await api<Receipt>(`task-refund-receipts/${encodeURIComponent(submission.digest)}?${query}`);
            if (result.digest !== submission.digest || !sameId(result.taskId, task.taskId) || result.action !== submission.action || result.status === "finalized" && !result.verification.startsWith("finalized_")) throw new Error("The refund receipt did not match this task and action.");
            setReceipt(result);
            if (result.status === "finalized") {
                sessionStorage.removeItem(`myso-agents:task-refund:${task.taskId}:pending`);
                sessionStorage.removeItem(`myso-agents:task-refund:${task.taskId}:${submission.action}:idempotency`);
                setSubmission(null);
                onUpdated();
            }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The refund receipt could not be verified yet."); }
        finally { setBusy(false); }
    }

    if (task.status !== 2 || !role) return null;
    const availableActions: RefundAction[] = task.refundProposer === 0 ? ["propose"] : task.refundProposer === role ? ["propose", "withdraw"] : ["accept", "reject"];
    return <section className="myso-settlement-receipt" aria-label="Delivered task refund agreement">
        <h3>Refund agreement</h3>
        <p>A delivered task can be refunded only by mutual agreement. Either party may propose; the other party can accept or reject, and the proposer can withdraw. Acceptance returns the full escrow to the buyer without task fees.</p>
        <p className="myso-knowledge-note" role="status">{pendingAction ? `Current proposal: ${pendingAction}${task.refundProposedAtMs ? ` · ${new Date(task.refundProposedAtMs).toLocaleString()}` : ""}.` : "No refund proposal is pending."}</p>
        {!submission && <div className="myso-task-action-row">{availableActions.map(action => <button key={action} type="button" className="myso-secondary" disabled={busy || !enabled(`task_${action}_refund`)} onClick={() => void submit(action)}>{labels[action]}</button>)}</div>}
        {submission && <><p className="myso-knowledge-note" role="status">{labels[submission.action]} submitted. Verify the exact task event before relying on the proposal change or escrow refund. Transaction {submission.digest}</p><button type="button" className="myso-secondary" disabled={busy} onClick={() => void verify()}>{busy ? "Checking fullnode…" : "Verify refund receipt"}</button></>}
        {receipt && <p className="myso-knowledge-note" role="status">{receipt.status === "finalized" ? `${labels[receipt.action]} finalized and verified.` : `Receipt status: ${receipt.status.replaceAll("_", " ")}`}</p>}
        {error && <p className="myso-error" role="alert">{error}</p>}
        <p className="myso-plan-note">Refund proposals are party-scoped and the chain rechecks task state and counterparty roles. If a jury dispute already owns the task, the refund flow is no longer available.</p>
    </section>;
}
