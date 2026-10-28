"use client";

import { useEffect, useState } from "react";
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";

type TransferStatus = { oauth_required?: boolean; oauth_complete?: boolean; authorize_url?: string | null };
type TransferJob = { status?: string; tx_digest?: string | null; error?: string | null };
type AcceptanceFlow = { beneficiaryId: string; idempotencyKey: string; approvalId: string; approvalIntent: string; phase: "requested" | "approved" | "prepared" | "submitted" | "finalized"; digest?: string };
type AcceptanceRequest = { approvalId: string; approvalIntent: string; idempotencyKey: string; beneficiaryId: string };
type AcceptancePrepared = { approvalId: string; beneficiaryId: string; idempotencyKey: string; registryAction: string; bytes: string; digest: string };
const same = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === b.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
async function acceptanceApi<T>(input: Record<string, unknown>): Promise<T> {
    const response = await fetch("/api/myso/beneficiary-acceptance", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Recipient acceptance could not continue");
    return result as T;
}

function RecipientAcceptance({ ownerAddress, network }: { ownerAddress: string; network: string }) {
    const wallets = useWallets(); const account = useCurrentAccount(); const { currentWallet } = useCurrentWallet();
    const connect = useConnectWallet(); const signMessage = useSignPersonalMessage(); const signTransaction = useSignTransaction();
    const [beneficiaryId, setBeneficiaryId] = useState(""); const [flow, setFlow] = useState<AcceptanceFlow | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [hydrated, setHydrated] = useState(false);
    const storageKey = `myso-agents:beneficiary-acceptance:${network}:${ownerAddress.toLowerCase()}`;
    const ownerMatches = !!account && same(account.address, ownerAddress) && !!currentWallet;
    const chain = `myso:${network}` as `${string}:${string}`;
    useEffect(() => { try { const raw = sessionStorage.getItem(storageKey); if (raw) { const value = JSON.parse(raw) as AcceptanceFlow; if (value && /^0x[0-9a-fA-F]{1,64}$/.test(value.beneficiaryId) && ["requested", "approved", "prepared", "submitted", "finalized"].includes(value.phase)) setFlow(value); } } catch { /* Ignore stale browser recovery data. */ } finally { setHydrated(true); } }, [storageKey]);
    useEffect(() => { if (!hydrated) return; if (flow) sessionStorage.setItem(storageKey, JSON.stringify(flow)); else sessionStorage.removeItem(storageKey); }, [flow, hydrated, storageKey]);

    async function readReceipt(target: AcceptanceFlow) {
        if (!target.digest) throw new Error("The acceptance transaction digest is missing");
        const value = await acceptanceApi<{ digest: string; status: string; beneficiaryId: string }>({ operation: "receipt", digest: target.digest, beneficiaryId: target.beneficiaryId });
        if (value.digest !== target.digest || value.status !== "finalized" || !same(value.beneficiaryId, target.beneficiaryId)) throw new Error("The finalized receipt does not match this beneficiary acceptance");
        const done = { ...target, phase: "finalized" as const }; setFlow(done); setMessage("Recipient acceptance is finalized and verified on chain.");
    }
    async function continueAcceptance(target: AcceptanceFlow) {
        if (!ownerMatches) { setMessage("Connect the recipient wallet for this MySo account before signing."); return; }
        setBusy(true); setMessage(""); let current = target;
        try {
            if (current.phase === "requested") {
                setMessage("Sign the exact recipient approval intent in your wallet…");
                const signedIntent = await signMessage.mutateAsync({ message: new TextEncoder().encode(current.approvalIntent), chain });
                await acceptanceApi({ operation: "approve", approvalId: current.approvalId, walletSignature: signedIntent.signature });
                current = { ...current, phase: "approved" }; setFlow(current);
            }
            if (current.phase === "approved" || current.phase === "prepared") {
                setMessage("Preparing the approved acceptance against the current beneficiary state…");
                const prepared = await acceptanceApi<AcceptancePrepared>({ operation: "prepare", beneficiaryId: current.beneficiaryId, approvalId: current.approvalId, idempotencyKey: current.idempotencyKey });
                if (prepared.approvalId !== current.approvalId || prepared.idempotencyKey !== current.idempotencyKey || !same(prepared.beneficiaryId, current.beneficiaryId) || prepared.registryAction !== "poc.accept_beneficiary_transfer.v1" || current.digest && prepared.digest !== current.digest) throw new Error("The prepared transaction did not match this recipient and beneficiary");
                current = { ...current, phase: "prepared", digest: prepared.digest }; setFlow(current);
                setMessage("Review and sign the exact acceptance transaction in your wallet…");
                const signed = await signTransaction.mutateAsync({ transaction: prepared.bytes, chain });
                await acceptanceApi({ operation: "submit", beneficiaryId: current.beneficiaryId, approvalId: current.approvalId, idempotencyKey: current.idempotencyKey, digest: prepared.digest, walletSignature: signed.signature });
                current = { ...current, phase: "submitted", digest: prepared.digest }; setFlow(current); setMessage("Submitted. Checking the finalized acceptance receipt…");
                await readReceipt(current);
            } else if (current.phase === "submitted") await readReceipt(current);
            else setMessage("This recipient acceptance is finalized and verified.");
        } catch (error) { setMessage(error instanceof Error ? error.message : "Recipient acceptance could not finish"); }
        finally { setBusy(false); }
    }
    async function requestAcceptance() {
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(beneficiaryId)) { setMessage("Enter the beneficiary object ID from the verified proposal."); return; }
        if (!ownerMatches) { setMessage("Connect the recipient wallet for this MySo account before requesting acceptance."); return; }
        setBusy(true); setMessage("Requesting an exact recipient-wallet approval…");
        try {
            const idempotencyKey = `poc-beneficiary-accept:${crypto.randomUUID()}`;
            const request = await acceptanceApi<AcceptanceRequest>({ operation: "request", beneficiaryId, idempotencyKey });
            if (request.beneficiaryId !== beneficiaryId || request.idempotencyKey !== idempotencyKey) throw new Error("The approval request did not match the selected beneficiary");
            const next: AcceptanceFlow = { ...request, phase: "requested" }; setFlow(next); await continueAcceptance(next);
        } catch (error) { setMessage(error instanceof Error ? error.message : "Recipient approval could not be requested"); }
        finally { setBusy(false); }
    }
    return <div className="myso-beneficiary-acceptance">
        <h3>Accept a verified beneficiary transfer</h3>
        <p>Enter the beneficiary object ID from the proposal. Only the proposed recipient wallet can accept. The beneficiary remains unclaimed until this transaction finalizes.</p>
        <label htmlFor="accept-beneficiary-id">Beneficiary object ID</label>
        <input id="accept-beneficiary-id" value={beneficiaryId} onChange={event => setBeneficiaryId(event.target.value.trim())} placeholder="0x…" autoComplete="off" />
        <p className="myso-knowledge-note">Recipient wallet: <code>{ownerAddress}</code> · Network: {network}</p>
        <div className="myso-toolbar">
            {!ownerMatches && <button type="button" className="myso-secondary" disabled={!wallets.length || busy} onClick={() => { const wallet = wallets[0]; if (wallet) connect.mutate({ wallet }); }}>Connect recipient wallet</button>}
            {!flow && <button type="button" className="myso-primary" disabled={busy || !ownerMatches || !/^0x[0-9a-fA-F]{1,64}$/.test(beneficiaryId)} onClick={() => void requestAcceptance()}>{busy ? "Working…" : "Review and accept"}</button>}
            {flow && flow.phase !== "finalized" && <button type="button" className="myso-primary" disabled={busy || !ownerMatches} onClick={() => void continueAcceptance(flow)}>{busy ? "Working…" : flow.phase === "submitted" ? "Check acceptance receipt" : "Continue acceptance"}</button>}
            {flow && <button type="button" className="myso-secondary" disabled={busy} onClick={() => { setFlow(null); setMessage("Pending acceptance cleared from this browser."); }}>Clear pending request</button>}
        </div>
        {flow?.digest && <p className="myso-knowledge-note">Acceptance transaction: <code>{flow.digest}</code></p>}
        {message && <p role="status" aria-live="polite" className="myso-knowledge-note">{message}</p>}
    </div>;
}

export function MySoBeneficiaryTransfer({ ownerAddress, network }: { ownerAddress: string; network: string }) {
    const [identityHash, setIdentityHash] = useState(""); const [beneficiaryId, setBeneficiaryId] = useState(""); const [recipientAddress, setRecipientAddress] = useState(""); const [authorizeUrl, setAuthorizeUrl] = useState<string>(); const [oauthComplete, setOauthComplete] = useState(false); const [jobId, setJobId] = useState<string>(); const [job, setJob] = useState<TransferJob>(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
    async function call(operation: "start" | "status" | "propose" | "job") {
        setBusy(true); setMessage("");
        try {
            const payload = operation === "job" ? { operation, identityHash, jobId } : operation === "propose" ? { operation, identityHash, beneficiaryId, recipientAddress } : { operation, identityHash, beneficiaryId };
            const response = await fetch("/api/myso/beneficiary-transfer", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) });
            const result = await response.json() as Record<string, unknown>;
            if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The transfer request could not be completed");
            if (operation === "start") { if (typeof result.authorize_url !== "string") throw new Error("The identity service did not return an authorization link"); setAuthorizeUrl(result.authorize_url); setMessage("Connect the creator’s X identity, then return here to check verification."); }
            else if (operation === "status") { const status = result as TransferStatus; setOauthComplete(status.oauth_complete === true); setMessage(status.oauth_complete ? "X identity verified. You can submit the recipient proposal." : "X identity verification is not complete yet."); }
            else if (operation === "propose") { if (typeof result.job_id !== "string") throw new Error("The oracle did not return a proposal job"); setJobId(result.job_id); setMessage("Proposal queued. Refresh its status to confirm the oracle transaction."); }
            else { setJob(result as TransferJob); setMessage(result.status === "completed" ? "Proposal confirmed on chain. The recipient can accept below using the proposed wallet." : result.status === "failed" ? "The oracle could not submit the proposal." : "The oracle is still processing the proposal."); }
        } catch (error) { setMessage(error instanceof Error ? error.message : "The transfer request could not be completed"); }
        finally { setBusy(false); }
    }
    const identityReady = /^0x[0-9a-fA-F]{2,64}$/.test(identityHash); const beneficiaryReady = /^0x[0-9a-fA-F]{1,64}$/.test(beneficiaryId); const recipientReady = /^0x[0-9a-fA-F]{1,64}$/.test(recipientAddress);
    return <section className="myso-create myso-beneficiary-transfer" aria-labelledby="beneficiary-transfer-title">
        <div className="myso-card-heading"><div><p className="myso-eyebrow">Creator identity</p><h2 id="beneficiary-transfer-title">Transfer an unclaimed creator beneficiary</h2></div></div>
        <p>Verify control of the creator’s X identity, propose one recipient, then have that recipient accept with their wallet. The chain keeps the beneficiary unclaimed until acceptance.</p>
        <p className="myso-knowledge-note">Connected wallet: <code>{ownerAddress}</code> · Network: {network}</p>
        <label htmlFor="beneficiary-identity-hash">Creator identity hash</label><input id="beneficiary-identity-hash" value={identityHash} onChange={event => { setIdentityHash(event.target.value.trim()); setOauthComplete(false); setAuthorizeUrl(undefined); }} placeholder="0x…" autoComplete="off" />
        <label htmlFor="beneficiary-object-id">Beneficiary object ID</label><input id="beneficiary-object-id" value={beneficiaryId} onChange={event => { setBeneficiaryId(event.target.value.trim()); setOauthComplete(false); setAuthorizeUrl(undefined); }} placeholder="0x…" autoComplete="off" />
        <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={busy || !identityReady || !beneficiaryReady} onClick={() => void call("start")}>{busy ? "Working…" : "Connect creator X identity"}</button><button type="button" className="myso-secondary" disabled={busy || !identityReady || !beneficiaryReady || !authorizeUrl} onClick={() => void call("status")}>Check verification</button>{authorizeUrl && <a className="myso-secondary" href={authorizeUrl} target="_blank" rel="noopener noreferrer">Open secure X authorization</a>}</div>
        <label htmlFor="beneficiary-recipient">Recipient wallet</label><input id="beneficiary-recipient" value={recipientAddress} onChange={event => setRecipientAddress(event.target.value.trim())} placeholder="0x…" autoComplete="off" />
        <div className="myso-toolbar"><button type="button" className="myso-primary" disabled={busy || !oauthComplete || !recipientReady} onClick={() => void call("propose")}>{busy ? "Submitting…" : "Propose recipient"}</button>{jobId && <button type="button" className="myso-secondary" disabled={busy} onClick={() => void call("job")}>Refresh proposal status</button>}</div>
        {job?.tx_digest && <p className="myso-knowledge-note">Proposal transaction: <code>{job.tx_digest}</code></p>}{message && <p role="status" aria-live="polite" className="myso-knowledge-note">{message}</p>}
        <RecipientAcceptance ownerAddress={ownerAddress} network={network} />
    </section>;
}
