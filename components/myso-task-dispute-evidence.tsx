"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionScope } from "@/src/core";

type Task = { taskId: string; status: number; buyerPrincipal: string; buyerAgentId: string | null; buyerMemoryAccountId: string; sellerPrincipal: string; sellerAgentId: string; sellerMemoryAccountId: string };
type Evidence = { index: string; submitter: string; round: string; kind: string; digest: string; uri: string; submittedAtMs: string };
type Dispute = { taskId: string; caseId: string; case: { state: number; currentRound: number; evidenceOpen: boolean; evidence: Evidence[] } | null };
type Pending = { digest: string; caseId: string; digestHex: string; uri: string; round: number };
type Receipt = Pending & { taskId: string; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The evidence request failed.");
    return data as T;
}
function sameId(left: string, right: string) { return left.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === right.replace(/^0x/i, "").toLowerCase().padStart(64, "0"); }
function parsePublicEvidenceUrl(value: string): URL {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    const [a = -1, b = -1] = ipv4 ?? [];
    const privateIpv4 = !!ipv4 && (ipv4.some(part => part > 255) || a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168);
    const localHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
    if (url.protocol !== "https:" || url.username || url.password || url.hash || new TextEncoder().encode(value).length > 2048 || privateIpv4 || localHost) throw new Error("Use a public HTTPS link without credentials, fragments, or a local/private address.");
    return url;
}
function safeEvidenceHref(value: string): string | null { try { return parsePublicEvidenceUrl(value).toString(); } catch { return null; } }
async function hashRemoteEvidence(uri: string): Promise<{ digestHex: string; byteLength: number }> {
    const url = parsePublicEvidenceUrl(uri);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await fetch(url.toString(), { method: "GET", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("The evidence link did not return readable content.");
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > 20 * 1024 * 1024)) throw new Error("Evidence must be at most 20 MiB.");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > 20 * 1024 * 1024) { await reader.cancel(); throw new Error("Evidence must be at most 20 MiB."); }
            chunks.push(value);
        }
        if (byteLength === 0) throw new Error("The evidence link returned an empty file.");
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const digestHex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { digestHex, byteLength };
    } finally { window.clearTimeout(timeout); }
}

export function MySoTaskDisputeEvidence({ task, scope, enabled, onUpdated }: { task: Task; scope: ExecutionScope | null; enabled: (action: string) => boolean; onUpdated: () => void }) {
    const [dispute, setDispute] = useState<Dispute | null>(null);
    const [uri, setUri] = useState("");
    const [acknowledged, setAcknowledged] = useState(false);
    const [verified, setVerified] = useState<{ uri: string; digestHex: string; byteLength: number } | null>(null);
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
    const prefix = `myso-agents:task-dispute:${task.taskId}:evidence`;

    useEffect(() => {
        if (![3, 4, 6].includes(task.status) || role === 0) { setDispute(null); return; }
        let active = true;
        setLoading(true); setError("");
        void api<Dispute>(`tasks/${encodeURIComponent(task.taskId)}/dispute`).then(value => {
            if (!sameId(value.taskId, task.taskId) || !/^0x[0-9a-fA-F]{1,64}$/.test(value.caseId)) throw new Error("Evidence details do not match this task.");
            if (active) setDispute(value);
        }).catch(reason => { if (active && task.status === 6) setError(reason instanceof Error ? reason.message : "Dispute evidence could not be loaded."); })
            .finally(() => { if (active) setLoading(false); });
        const saved = sessionStorage.getItem(`${prefix}:pending`);
        if (saved) { try { setPending(JSON.parse(saved) as Pending); } catch { sessionStorage.removeItem(`${prefix}:pending`); } }
        return () => { active = false; };
    }, [role, task.status, task.taskId]);

    async function verifyLink() {
        if (!acknowledged || busy) return;
        setBusy(true); setError(""); setVerified(null);
        try { const result = await hashRemoteEvidence(uri); setVerified({ uri, ...result }); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "The public evidence link could not be verified."); }
        finally { setBusy(false); }
    }

    async function submit() {
        if (!dispute?.case?.evidenceOpen || !dispute.case || !verified || verified.uri !== uri || !acknowledged || !enabled("task_dispute_evidence") || busy) return;
        setBusy(true); setError("");
        const saved = sessionStorage.getItem(`${prefix}:intent`);
        let idempotencyKey: string;
        try {
            const intent = saved ? JSON.parse(saved) as { uri: string; digestHex: string; key: string } : null;
            idempotencyKey = intent?.uri === uri && intent.digestHex === verified.digestHex ? intent.key : crypto.randomUUID();
        } catch { idempotencyKey = crypto.randomUUID(); }
        sessionStorage.setItem(`${prefix}:intent`, JSON.stringify({ uri, digestHex: verified.digestHex, key: idempotencyKey }));
        try {
            const result = await api<{ taskId: string; caseId: string; transactionDigest: string; digestHex: string; uri: string; round: number }>(`tasks/${encodeURIComponent(task.taskId)}/dispute/evidence`, { method: "POST", body: JSON.stringify({ digestHex: verified.digestHex, uri, idempotencyKey }) });
            if (!sameId(result.taskId, task.taskId) || !sameId(result.caseId, dispute.caseId) || result.digestHex !== verified.digestHex || result.uri !== uri || result.round !== dispute.case.currentRound || !result.transactionDigest) throw new Error("The evidence transaction did not match this case, link, and round.");
            const next = { digest: result.transactionDigest, caseId: result.caseId, digestHex: result.digestHex, uri: result.uri, round: result.round };
            setPending(next); sessionStorage.setItem(`${prefix}:pending`, JSON.stringify(next));
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Evidence could not be submitted."); }
        finally { setBusy(false); }
    }

    async function verifyReceipt() {
        if (!pending || busy) return;
        setBusy(true); setError("");
        try {
            const query = new URLSearchParams({ taskId: task.taskId, caseId: pending.caseId, digestHex: pending.digestHex, uri: pending.uri, round: String(pending.round) });
            const result = await api<Receipt>(`task-dispute-evidence-receipts/${encodeURIComponent(pending.digest)}?${query}`);
            if (result.digest !== pending.digest || !sameId(result.taskId, task.taskId) || !sameId(result.caseId, pending.caseId) || result.digestHex !== pending.digestHex || result.uri !== pending.uri || result.round !== pending.round || result.status === "finalized" && result.verification !== "finalized_task_dispute_evidence_event") throw new Error("The evidence receipt did not match the submitted content.");
            setReceipt(result);
            if (result.status === "finalized") { sessionStorage.removeItem(`${prefix}:pending`); sessionStorage.removeItem(`${prefix}:intent`); setPending(null); onUpdated(); }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The evidence receipt could not be verified yet."); }
        finally { setBusy(false); }
    }

    if (!role || task.status !== 6 && !dispute) return null;
    const evidenceOpen = dispute?.case?.evidenceOpen === true;
    return <section className="myso-settlement-receipt" aria-label="Submit task dispute evidence">
        <h3>Case evidence</h3>
        {loading && <p className="myso-knowledge-note" role="status">Loading current case evidence…</p>}
        {dispute?.case && <><p>Evidence submissions are {evidenceOpen ? "open for this jury round" : "closed"}. Each party may submit up to eight references. Jury-case links, digests, and submitter identity are public on chain.</p>
            {dispute.case.evidence.length > 0 && <ol>{dispute.case.evidence.map(item => <li key={`${item.index}:${item.digest}`}><span>Round {Number(item.round) + 1} · {sameId(item.submitter, task.buyerPrincipal) ? "Buyer" : "Seller"}</span> {safeEvidenceHref(item.uri) ? <a href={safeEvidenceHref(item.uri)!} target="_blank" rel="noreferrer noopener">Open evidence link</a> : <span>Non-HTTPS evidence URI</span>} <code>{item.digest}</code></li>)}</ol>}
        </>}
        {evidenceOpen && !pending && <div className="myso-room-invite">
            <label htmlFor={`dispute-evidence-uri-${task.taskId}`}>Public evidence URL<input id={`dispute-evidence-uri-${task.taskId}`} type="url" required maxLength={2048} value={uri} onChange={event => { setUri(event.target.value); setVerified(null); }} placeholder="https://…" /></label>
            <label><input type="checkbox" checked={acknowledged} onChange={event => { setAcknowledged(event.target.checked); setVerified(null); }} /> I have the right to share this evidence; the URL and digest will be public, and jury members must be able to open it.</label>
            <button type="button" className="myso-secondary" disabled={!acknowledged || !uri || busy} onClick={() => void verifyLink()}>{busy && !verified ? "Checking public content…" : "Fetch and hash evidence"}</button>
            {verified && <p className="myso-knowledge-note" role="status">Fetched {verified.byteLength.toLocaleString()} bytes and computed SHA-256 {verified.digestHex}. The chain stores this digest and URL; the app does not store the file.</p>}
            {verified && <button type="button" className="myso-secondary" disabled={busy || !enabled("task_dispute_evidence")} onClick={() => void submit()}>{busy ? "Submitting evidence…" : "Submit evidence to jury"}</button>}
        </div>}
        {pending && <><p className="myso-knowledge-note" role="status">Evidence transaction submitted for round {pending.round + 1}. Verify the finalized `EvidenceSubmitted` event before treating the evidence as recorded. Transaction {pending.digest}</p><button type="button" className="myso-secondary" disabled={busy} onClick={() => void verifyReceipt()}>{busy ? "Checking fullnode…" : "Verify evidence receipt"}</button></>}
        {receipt && <p className="myso-knowledge-note" role="status">{receipt.status === "finalized" ? "Evidence URL and digest are finalized in the jury case." : `Receipt status: ${receipt.status.replaceAll("_", " ")}`}</p>}
        {!enabled("task_dispute_evidence") && evidenceOpen && <p className="myso-knowledge-note">Evidence submission is unavailable under the connected agent’s current task permissions.</p>}
        {error && <p className="myso-error" role="alert">{error}</p>}
    </section>;
}
