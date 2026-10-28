"use client";

import { useEffect, useRef, useState } from "react";
import { useConnectWallet, useCurrentAccount, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { Wallet } from "lucide-react";

type Phase = "requested" | "approved" | "prepared" | "submitted" | "finalized";
type Recovery = { phase: Phase; idempotencyKey: string; approvalId?: string; digest?: string };
type Request = { approvalId: string; approvalIntent: string; recipient: string; accessType: 0 | 1; idempotencyKey: string };
type Prepared = { approvalId: string; bytes: string; digest: string; recipient: string; accessType: 0 | 1 };
const phases: Phase[] = ["requested", "approved", "prepared", "submitted", "finalized"];
const same = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === b.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
async function call<T>(input: Record<string, unknown>): Promise<T> {
    const response = await fetch("/api/myso/knowledge/purchase", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Graph access could not be changed");
    return result as T;
}
function parseRecovery(value: string | null): Recovery | null {
    if (!value) return null;
    try {
        const item = JSON.parse(value) as Record<string, unknown>;
        if (typeof item.idempotencyKey !== "string" || item.idempotencyKey.length < 8 || !phases.includes(item.phase as Phase)) return null;
        if (item.approvalId !== undefined && (typeof item.approvalId !== "string" || !/^[0-9a-f-]{36}$/i.test(item.approvalId))) return null;
        if (item.digest !== undefined && (typeof item.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(item.digest))) return null;
        if (["prepared", "submitted", "finalized"].includes(String(item.phase)) && typeof item.digest !== "string") return null;
        return item as Recovery;
    } catch { return null; }
}

/** Recovery path for owner-funded graph purchases, independent of the seller's current offer listing. */
export function MySoGraphAccessManager({ mydataId, accessKind, ownerAddress, agentAddress, network, onRevoked }: { mydataId: string; accessKind: 2 | 3; ownerAddress: string; agentAddress: string; network: string; onRevoked?: () => void }) {
    const wallets = useWallets();
    const account = useCurrentAccount();
    const connect = useConnectWallet();
    const signMessage = useSignPersonalMessage();
    const signTransaction = useSignTransaction();
    const onRevokedRef = useRef(onRevoked);
    onRevokedRef.current = onRevoked;
    const storageKey = `myso-agents:graph-access-revoke:${network}:${ownerAddress.toLowerCase()}:${agentAddress.toLowerCase()}:${mydataId.toLowerCase()}:${accessKind}`;
    const [saved, setSaved] = useState<Recovery | null>(null);
    const [revocationVerified, setRevocationVerified] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    useEffect(() => {
        const value = parseRecovery(localStorage.getItem(storageKey));
        setSaved(value);
        setRevocationVerified(false);
    }, [storageKey]);
    useEffect(() => {
        let active = true;
        if (saved?.phase !== "finalized" || !saved.digest) return () => { active = false; };
        void call({ operation: "revoke-receipt", digest: saved.digest, mydataId, audienceKind: "agent", accessKind })
            .then(() => { if (active) { setRevocationVerified(true); onRevokedRef.current?.(); } })
            .catch(() => { if (active) setRevocationVerified(false); });
        return () => { active = false; };
    }, [saved, storageKey, mydataId, accessKind]);
    function persist(value: Recovery) {
        setSaved(value);
        try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* The current wallet flow remains usable without browser storage. */ }
    }
    async function resume() {
        if (!account || !same(account.address, ownerAddress)) { setMessage("Connect the owner wallet before revoking this agent's access."); return; }
        setBusy(true);
        try {
            let current = saved;
            if (!current) {
                current = { phase: "requested", idempotencyKey: `graph-revoke:${mydataId}:${crypto.randomUUID()}` };
                persist(current);
            }
            if (current.phase === "finalized" && current.digest) {
                await call({ operation: "revoke-receipt", digest: current.digest, mydataId, audienceKind: "agent", accessKind });
                setRevocationVerified(true);
                setMessage("The fullnode confirms this agent's access was revoked.");
                onRevoked?.();
                return;
            }
            if (current.phase === "submitted" && current.digest) {
                await call({ operation: "revoke-receipt", digest: current.digest, mydataId, audienceKind: "agent", accessKind });
                persist({ ...current, phase: "finalized" });
                setMessage("The finalized revocation blocks future key releases for this listing and agent. Previously disclosed data cannot be recalled.");
                return;
            }
            let approvalId = current.approvalId;
            if (current.phase === "requested") {
                const request = await call<Request>({ operation: "revoke-request", mydataId, audienceKind: "agent", accessKind, idempotencyKey: current.idempotencyKey });
                if (!same(request.recipient, agentAddress) || request.accessType !== (accessKind === 2 ? 0 : 1)) throw new Error("The approval request did not match this agent and graph access type");
                approvalId = request.approvalId;
                persist({ ...current, approvalId });
                const intent = await signMessage.mutateAsync({ message: new TextEncoder().encode(request.approvalIntent), chain: `myso:${network}` });
                await call({ operation: "revoke-approve", approvalId, walletSignature: intent.signature, mydataId, audienceKind: "agent", accessKind });
                current = { ...current, phase: "approved", approvalId };
                persist(current);
            }
            if (current.phase === "approved" || current.phase === "prepared") {
                if (!approvalId) throw new Error("The saved owner approval is missing; start a new revocation request");
                const prepared = await call<Prepared>({ operation: "revoke-prepare", mydataId, audienceKind: "agent", accessKind, idempotencyKey: current.idempotencyKey, approvalId });
                if (prepared.approvalId !== approvalId || !same(prepared.recipient, agentAddress) || prepared.accessType !== (accessKind === 2 ? 0 : 1) || current.digest && current.digest !== prepared.digest) throw new Error("The prepared revocation did not match the saved approval and graph audience");
                current = { ...current, phase: "prepared", digest: prepared.digest };
                persist(current);
                const signed = await signTransaction.mutateAsync({ transaction: prepared.bytes, chain: `myso:${network}` });
                await call({ operation: "revoke-submit", mydataId, audienceKind: "agent", accessKind, idempotencyKey: current.idempotencyKey, approvalId, digest: prepared.digest, walletSignature: signed.signature });
                current = { ...current, phase: "submitted" };
                persist(current);
            }
            if (current.phase === "submitted" && current.digest) {
                await call({ operation: "revoke-receipt", digest: current.digest, mydataId, audienceKind: "agent", accessKind });
                persist({ ...current, phase: "finalized" });
                setMessage("The finalized revocation blocks future key releases for this listing and agent. Previously disclosed data cannot be recalled.");
                onRevoked?.();
            } else setMessage("The revocation is saved. Continue to complete or verify the same operation.");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "Graph access revocation could not be completed");
        } finally { setBusy(false); }
    }
    const finalized = saved?.phase === "finalized" && revocationVerified;
    return <div className="myso-graph-access-manager">
        {finalized ? <p className="myso-knowledge-note" role="status">Future access revoked for this listing and agent.</p> : <div className="myso-toolbar">
            {(!account || !same(account.address, ownerAddress)) && wallets.map(wallet => <button key={wallet.name} type="button" className="myso-secondary" disabled={busy || connect.isPending} onClick={() => void connect.mutateAsync({ wallet, accountAddress: ownerAddress }).catch(error => setMessage(error instanceof Error ? error.message : "Wallet connection failed"))}><Wallet size={15}/>{connect.isPending ? "Connecting…" : `Connect ${wallet.name}`}</button>)}
            <button type="button" className="myso-secondary" disabled={busy || !account || !same(account.address, ownerAddress)} onClick={() => void resume()}>{busy ? "Verifying owner approval…" : saved ? "Resume or verify agent-access revocation" : "Revoke this agent’s future access"}</button>
        </div>}
        {message && <p className="myso-knowledge-note" role="status">{message}</p>}
        {!finalized && <small>Requires the owner wallet’s approval and transaction signature. Revocation affects future key releases only; it cannot recall content already decrypted.</small>}
    </div>;
}
