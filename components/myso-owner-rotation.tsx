"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Wallet } from "lucide-react";
import { useConnectWallet, useCurrentAccount, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import {
    buildAcceptOwnerRotationBatchTransaction,
    buildCancelOwnerRotationTransaction,
    buildRollbackOwnerRotationBatchTransaction,
    buildProposeOwnerRotationTransaction,
    loadCompleteOwnerRotationManifest,
    loadPendingOwnerRotation,
    loadOwnerRotationProgress,
    prepareOwnerRotationTransaction,
    type CompleteOwnerRotationManifest,
    type OwnerRotationChainConfig,
} from "@/src/agent/myso-owner-rotation";
import { buildMySoMultisig, signMySoTransactionWithMultisig, type MySoMultisigMember } from "@/src/agent/myso-multisig";
import { MySoTransferableAssets } from "./myso-transferable-assets";

interface Props {
    ownerAddress: string;
    accountId: string;
    network: string;
    rpcUrl: string;
    socialChain: OwnerRotationChainConfig;
}

interface PendingRotation {
    accountId: string;
    oldOwner: string;
    newOwner: string;
    proposalDigest: string;
    agentCount: string;
    organizationCount: string;
    verified: boolean;
}
interface MultisigDescriptor { format: "myso-protocol-multisig-v1"; address: string; publicKeyBase64: string; threshold: number; members: Array<{ address: string; publicKeyBase64: string; weight: number }>; execution: string }

function canonical(value: string): string {
    return `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

function readEventField(event: { parsedJson?: unknown }, snake: string, camel: string): unknown {
    if (!event.parsedJson || typeof event.parsedJson !== "object") return undefined;
    const value = event.parsedJson as Record<string, unknown>;
    return value[snake] ?? value[camel];
}

function eventFor(events: Array<{ type?: string; parsedJson?: unknown }>, suffix: string) {
    const matches = events.filter((event) => event.type?.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`The finalized transaction did not contain exactly one ${suffix} event`);
    return matches[0]!;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export function MySoOwnerRotation({ ownerAddress, accountId, network, rpcUrl, socialChain }: Props) {
    const wallets = useWallets();
    const account = useCurrentAccount();
    const connect = useConnectWallet();
    const signTransaction = useSignTransaction();
    const [newOwner, setNewOwner] = useState("");
    const [pending, setPending] = useState<PendingRotation | null>(null);
    const [manifest, setManifest] = useState<CompleteOwnerRotationManifest | null>(null);
    const [progress, setProgress] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [selectedMultisigAddresses, setSelectedMultisigAddresses] = useState<string[]>([]);
    const [multisigThreshold, setMultisigThreshold] = useState("1");
    const [multisigDescriptor, setMultisigDescriptor] = useState<MultisigDescriptor | null>(null);
    const [multisigPreparing, setMultisigPreparing] = useState(false);
    const [multisigPrepareError, setMultisigPrepareError] = useState("");

    useEffect(() => {
        try {
            const saved = localStorage.getItem(`myso-agents:owner-rotation:${canonical(accountId)}`);
            if (!saved) return;
            const value = JSON.parse(saved) as PendingRotation;
            if (value.accountId === accountId && canonical(value.oldOwner) === canonical(ownerAddress)
                && /^0x[0-9a-fA-F]{1,64}$/.test(value.newOwner) && typeof value.proposalDigest === "string"
                && /^\d+$/.test(value.agentCount) && /^\d+$/.test(value.organizationCount)
                && typeof value.verified === "boolean") {
                setPending(value);
            } else {
                localStorage.removeItem(`myso-agents:owner-rotation:${canonical(accountId)}`);
            }
        } catch {
            localStorage.removeItem(`myso-agents:owner-rotation:${canonical(accountId)}`);
        }
    }, [accountId, ownerAddress]);

    const client = useMemo(
        () => new MySoJsonRpcClient({ url: rpcUrl, network: network as "mainnet" | "testnet" | "devnet" | "localnet" }),
        [network, rpcUrl],
    );

    useEffect(() => {
        const controller = new AbortController();
        void loadPendingOwnerRotation(client, socialChain, accountId, controller.signal).then((chainPending) => {
            const key = `myso-agents:owner-rotation:${canonical(accountId)}`;
            if (!chainPending) {
                setPending(null);
                localStorage.removeItem(key);
                return;
            }
            let proposalDigest = "";
            try {
                const saved = localStorage.getItem(key);
                const cached = saved ? JSON.parse(saved) as Partial<PendingRotation> : null;
                if (cached && canonical(cached.oldOwner ?? "") === chainPending.oldOwner
                    && canonical(cached.newOwner ?? "") === chainPending.newOwner
                    && cached.proposalDigest && /^[-A-Za-z0-9_]+$/.test(cached.proposalDigest)) {
                    proposalDigest = cached.proposalDigest;
                }
            } catch { /* the chain record is authoritative; discard malformed cache data */ }
            const recovered: PendingRotation = {
                accountId: chainPending.accountId,
                oldOwner: chainPending.oldOwner,
                newOwner: chainPending.newOwner,
                proposalDigest,
                agentCount: chainPending.agentCount,
                organizationCount: chainPending.organizationCount,
                verified: true,
            };
            setPending(recovered);
            localStorage.setItem(key, JSON.stringify(recovered));
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "The on-chain owner migration state could not be read");
        });
        return () => controller.abort();
    }, [accountId, client, socialChain]);
    useEffect(() => {
        const key = `myso-agents:owner-multisig:${network}:${canonical(accountId)}`;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return;
            const saved: unknown = JSON.parse(raw);
            if (!saved || typeof saved !== "object") throw new Error("Invalid multisig cache");
            const value = saved as { addresses?: unknown; threshold?: unknown };
            if (!Array.isArray(value.addresses) || value.addresses.length > 10
                || value.addresses.some((address) => typeof address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(address))
                || new Set(value.addresses.map((address) => canonical(String(address)))).size !== value.addresses.length
                || typeof value.threshold !== "string" || !/^\d{1,4}$/.test(value.threshold)
                || Number(value.threshold) < 1 || Number(value.threshold) > 2550) {
                throw new Error("Invalid multisig cache");
            }
            setSelectedMultisigAddresses(value.addresses as string[]);
            setMultisigThreshold(value.threshold);
        } catch {
            localStorage.removeItem(key);
        }
    }, [accountId, network]);
    useEffect(() => { setMultisigDescriptor(null); setMultisigPrepareError(""); }, [accountId, network]);
    const ownerMatches = !!account?.address && canonical(account.address) === canonical(ownerAddress);
    const recipientMatches = !!account?.address && !!pending && canonical(account.address) === canonical(pending.newOwner);
    const validNewOwner = /^0x[0-9a-fA-F]{1,64}$/.test(newOwner) && canonical(newOwner) !== canonical(ownerAddress);
    const availableMultisigAccounts = wallets.flatMap((wallet) => wallet.accounts.map((walletAccount) => ({
        wallet,
        account: walletAccount,
        address: walletAccount.address,
        publicKey: Uint8Array.from(walletAccount.publicKey),
        weight: 1,
    })));
    const selectedMultisigMembers: Array<MySoMultisigMember & { wallet: typeof wallets[number]; account: typeof wallets[number]["accounts"][number] }> =
        selectedMultisigAddresses.flatMap((address) => {
            const selected = availableMultisigAccounts.find((candidate) => canonical(candidate.address) === canonical(address));
            return selected ? [{ ...selected, address: selected.address }] : [];
        });
    let multisigConfig: ReturnType<typeof buildMySoMultisig> | null = null;
    let multisigError = "";
    if (selectedMultisigMembers.length) {
        try {
            multisigConfig = buildMySoMultisig(selectedMultisigMembers, Number(multisigThreshold));
        } catch (error) {
            multisigError = error instanceof Error ? error.message : "The multisig configuration is invalid";
        }
    }
    const multisigDescriptorMatches = !!multisigDescriptor && !!multisigConfig
        && canonical(multisigDescriptor.address) === canonical(multisigConfig.address)
        && multisigDescriptor.threshold === Number(multisigThreshold)
        && multisigDescriptor.members.length === selectedMultisigMembers.length
        && multisigDescriptor.members.every((member, index) => {
            const selected = selectedMultisigMembers[index];
            return !!selected && canonical(member.address) === canonical(selected.address)
                && member.publicKeyBase64 === encodeBase64(selected.publicKey) && member.weight === selected.weight;
        });
    const multisigRecipientMatches = !!pending && !!multisigConfig && multisigDescriptorMatches && canonical(multisigConfig.address) === canonical(pending.newOwner);
    const pendingRecipientMatches = recipientMatches || multisigRecipientMatches;
    const chainConfigured = /^0x[0-9a-fA-F]{1,64}$/.test(socialChain.usernameRegistryId)
        && /^0x[0-9a-fA-F]{1,64}$/.test(socialChain.memoryRegistryId);

    async function readManifest(): Promise<CompleteOwnerRotationManifest> {
        setProgress("Reading all registered agents and organizations from the fullnode…");
        const value = await loadCompleteOwnerRotationManifest(undefined, (kind, pages, count) => {
            setProgress(`Reading ${kind}: ${count} objects across ${pages} page${pages === 1 ? "" : "s"}…`);
        });
        if (canonical(value.accountId) !== canonical(accountId) || canonical(value.owner) !== canonical(ownerAddress)) {
            throw new Error("The connected MySo session changed; refresh the account context before migrating");
        }
        setManifest(value);
        return value;
    }

    async function executeAndVerify(bytes: Uint8Array, sender: string, eventCheck: (events: Array<{ type?: string; parsedJson?: unknown }>) => void, onSubmitted?: (digest: string) => void, signatureOverride?: string) {
        const transactionBlock = encodeBase64(bytes);
        const signed = signatureOverride
            ? { signature: signatureOverride }
            : await signTransaction.mutateAsync({ transaction: transactionBlock, chain: `myso:${network}` });
        const submitted = await client.executeTransactionBlock({
            transactionBlock,
            signature: signed.signature,
            options: { showEffects: true, showEvents: true },
        });
        const digest = submitted.digest;
        onSubmitted?.(digest);
        setMessage(`Transaction submitted: ${digest}. Checking the finalized event…`);
        await client.waitForTransaction({ digest, timeout: 60_000, pollInterval: 1_000 });
        const receipt = await client.getTransactionBlock({ digest, options: { showEffects: true, showEvents: true } });
        if (receipt.effects?.status?.status !== "success") throw new Error(`Transaction ${digest} did not succeed`);
        eventCheck(receipt.events ?? []);
        return digest;
    }

    async function verifyScopedMcpReceipt(digest: string, stage: "proposal" | "accepted", oldWallet: string, newWallet: string, expected?: Pick<PendingRotation, "agentCount" | "organizationCount">) {
        const response = await fetch(`/api/myso/owner-rotation/receipt?id=${encodeURIComponent(digest)}`, {
            method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body !== "object") {
            const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "The MCP migration receipt could not be verified";
            throw new Error(message);
        }
        const receipt = body as Record<string, unknown>;
        if (receipt.digest !== digest || receipt.accountId === undefined || canonical(String(receipt.accountId)) !== canonical(accountId)
            || receipt.status !== "finalized" || receipt.stage !== stage
            || canonical(String(receipt.oldOwner)) !== canonical(oldWallet)
            || canonical(String(receipt.newOwner)) !== canonical(newWallet)) {
            throw new Error("The MCP migration receipt does not match this finalized two-wallet flow");
        }
        if (expected && (receipt.updatedAgentCount !== expected.agentCount || receipt.updatedOrganizationCount !== expected.organizationCount)) {
            throw new Error("The MCP receipt did not verify every registered agent and organization reference");
        }
    }

    async function beginProposal() {
        if (!ownerMatches || !validNewOwner) return;
        setBusy(true); setMessage("");
        try {
            const current = await readManifest();
            const tx = buildProposeOwnerRotationTransaction({ client, chain: socialChain, accountId, profileId: current.profileId }, current, newOwner);
            setProgress("Review the complete object manifest, then sign the proposal with the current owner wallet…");
            const bytes = await prepareOwnerRotationTransaction(client, tx, ownerAddress);
            const next: PendingRotation = { accountId, oldOwner: ownerAddress, newOwner, proposalDigest: "", agentCount: current.agentCount, organizationCount: current.organizationCount, verified: false };
            let digest = "";
            digest = await executeAndVerify(bytes, ownerAddress, (events) => {
                const proposed = eventFor(events, "::memory::MemoryAccountOwnerRotationProposed");
                if (canonical(String(readEventField(proposed, "account_id", "accountId"))) !== canonical(accountId)
                    || canonical(String(readEventField(proposed, "old_owner", "oldOwner"))) !== canonical(ownerAddress)
                    || canonical(String(readEventField(proposed, "new_owner", "newOwner"))) !== canonical(newOwner)
                    || BigInt(String(readEventField(proposed, "agent_count", "agentCount"))) !== BigInt(current.agentCount)
                    || BigInt(String(readEventField(proposed, "organization_count", "organizationCount"))) !== BigInt(current.organizationCount)) {
                    throw new Error("The finalized proposal event does not match the complete owner manifest");
                }
            }, (submittedDigest) => {
                next.proposalDigest = submittedDigest;
                setPending({ ...next });
                localStorage.setItem(`myso-agents:owner-rotation:${canonical(accountId)}`, JSON.stringify(next));
            });
            await verifyScopedMcpReceipt(digest, "proposal", ownerAddress, newOwner, current);
            next.proposalDigest = digest; next.verified = true;
            setPending(next);
            localStorage.setItem(`myso-agents:owner-rotation:${canonical(accountId)}`, JSON.stringify(next));
            setMessage("Proposal finalized. Connect the recipient wallet to accept and update every registered reference.");
            setProgress("");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "The owner migration proposal failed");
        } finally { setBusy(false); }
    }

    async function acceptProposal() {
        if (!pending || !pending.verified || (!recipientMatches && !multisigRecipientMatches)) return;
        setBusy(true); setMessage("");
        try {
            const progressState = await loadOwnerRotationProgress(client, socialChain, accountId);
            if (progressState.oldOwner !== canonical(pending.oldOwner) || progressState.newOwner !== canonical(pending.newOwner)
                || progressState.agentCount !== pending.agentCount || progressState.organizationCount !== pending.organizationCount) {
                throw new Error("The live pending migration does not match the approved recipient and manifest");
            }
            const current: CompleteOwnerRotationManifest = {
                accountId: progressState.accountId, owner: progressState.oldOwner, profileId: progressState.profileId,
                agentObjectIds: progressState.agentObjectIds, organizationObjectIds: progressState.organizationObjectIds,
                agentCount: progressState.agentCount, organizationCount: progressState.organizationCount,
                evidenceSource: "configured_fullnode",
            };
            setManifest(current);
            const updatedAgents = new Set(progressState.updatedAgentObjectIds.map(canonical));
            const updatedOrganizations = new Set(progressState.updatedOrganizationObjectIds.map(canonical));
            let remainingAgents = current.agentObjectIds.filter((id) => !updatedAgents.has(canonical(id)));
            let remainingOrganizations = current.organizationObjectIds.filter((id) => !updatedOrganizations.has(canonical(id)));
            const batchSize = 6;
            let batchIndex = 0;
            let lastDigest = "";
            do {
                const agentBatch = remainingAgents.splice(0, batchSize);
                const organizationBatch = remainingOrganizations.splice(0, Math.max(0, batchSize - agentBatch.length));
                const finalize = remainingAgents.length === 0 && remainingOrganizations.length === 0;
                batchIndex += 1;
                const tx = buildAcceptOwnerRotationBatchTransaction(
                    { client, chain: socialChain, accountId, profileId: current.profileId }, current, pending.newOwner,
                    agentBatch, organizationBatch, finalize,
                );
                const expected = new Map<string, number>();
                for (const id of agentBatch) expected.set(canonical(id), 1);
                for (const id of organizationBatch) expected.set(canonical(id), 2);
                setProgress(finalize
                    ? `Signing batch ${batchIndex}: finalize the account after updating all ${current.agentCount} agents and ${current.organizationCount} organizations…`
                    : `Signing batch ${batchIndex}: update ${agentBatch.length} agents and ${organizationBatch.length} organizations. You can resume later from the on-chain progress…`);
                const bytes = await prepareOwnerRotationTransaction(client, tx, pending.newOwner);
                let multisigSignature: string | undefined;
                if (multisigRecipientMatches) {
                    if (!multisigConfig || selectedMultisigMembers.length < 2) throw new Error("Select the multisig members and threshold that derive the pending recipient address");
                    const preparedBase64 = encodeBase64(bytes);
                    const combined = await signMySoTransactionWithMultisig({
                        multisig: multisigConfig,
                        transactionBlockBase64: preparedBase64,
                        chain: `myso:${network}`,
                        signers: selectedMultisigMembers.map(({ wallet, account }) => ({
                            wallet,
                            account: { ...account, publicKey: Uint8Array.from(account.publicKey) },
                        })),
                    });
                    if (combined.bytes !== preparedBase64) throw new Error("The multisig wallets returned different transaction bytes from the prepared migration batch");
                    multisigSignature = combined.signature;
                }
                lastDigest = await executeAndVerify(bytes, pending.newOwner, (events) => {
                    const references = events.filter((event) => event.type?.endsWith("::memory::MemoryAccountOwnerRotationReferenceUpdated"));
                    if (references.length !== expected.size) throw new Error("The finalized batch updated an unexpected number of registered references");
                    for (const event of references) {
                        const id = canonical(String(readEventField(event, "reference_id", "referenceId")));
                        const kind = Number(readEventField(event, "reference_kind", "referenceKind"));
                        if (expected.get(id) !== kind
                            || canonical(String(readEventField(event, "old_owner", "oldOwner"))) !== canonical(pending.oldOwner)
                            || canonical(String(readEventField(event, "new_owner", "newOwner"))) !== canonical(pending.newOwner)) {
                            throw new Error("A registered-reference event does not match this migration batch");
                        }
                        expected.delete(id);
                    }
                    if (expected.size) throw new Error("The finalized batch omitted registered references");
                    const rotated = events.filter((event) => event.type?.endsWith("::memory::MemoryAccountOwnerRotated"));
                    const profileEvents = events.filter((event) => event.type?.endsWith("::profile::ProfileOwnerRotatedEvent"));
                    if (finalize) {
                        const memory = eventFor(events, "::memory::MemoryAccountOwnerRotated");
                        const profile = eventFor(events, "::profile::ProfileOwnerRotatedEvent");
                        for (const event of [memory, profile]) {
                            if (canonical(String(readEventField(event, "old_owner", "oldOwner"))) !== canonical(pending.oldOwner)
                                || canonical(String(readEventField(event, "new_owner", "newOwner"))) !== canonical(pending.newOwner)
                                || canonical(String(readEventField(event, "profile_id", "profileId"))) !== canonical(current.profileId)) {
                                throw new Error("The finalized ownership event does not match the proposal");
                            }
                        }
                    } else if (rotated.length || profileEvents.length) {
                        throw new Error("An intermediate batch unexpectedly changed the account or linked profile owner");
                    }
                }, undefined, multisigSignature);
                if (finalize) {
                    await verifyScopedMcpReceipt(lastDigest, "accepted", pending.oldOwner, pending.newOwner, pending);
                } else {
                    const latest = await loadOwnerRotationProgress(client, socialChain, accountId);
                    if (latest.updatedAgentObjectIds.length !== updatedAgents.size + agentBatch.length
                        || latest.updatedOrganizationObjectIds.length !== updatedOrganizations.size + organizationBatch.length) {
                        throw new Error("The on-chain migration progress does not reflect the finalized batch; refresh and resume");
                    }
                    for (const id of agentBatch) if (!latest.updatedAgentObjectIds.some((candidate) => canonical(candidate) === canonical(id))) throw new Error("A finalized agent reference update is missing from on-chain progress");
                    for (const id of organizationBatch) if (!latest.updatedOrganizationObjectIds.some((candidate) => canonical(candidate) === canonical(id))) throw new Error("A finalized organization reference update is missing from on-chain progress");
                    agentBatch.forEach((id) => updatedAgents.add(canonical(id)));
                    organizationBatch.forEach((id) => updatedOrganizations.add(canonical(id)));
                    setProgress(`Batch ${batchIndex} finalized and verified. ${remainingAgents.length} agents and ${remainingOrganizations.length} organizations remain…`);
                }
            } while (remainingAgents.length > 0 || remainingOrganizations.length > 0);
            setPending(null); setManifest(null); localStorage.removeItem(`myso-agents:owner-rotation:${canonical(accountId)}`);
            setMessage(`Owner migration finalized and verified in ${lastDigest}. Reconnect MySo as the new owner to refresh your session.`);
            setProgress("");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "The recipient acceptance failed");
        } finally { setBusy(false); }
    }

    async function verifyPendingProposal() {
        if (!pending?.proposalDigest) return;
        setBusy(true); setMessage("");
        try {
            await client.waitForTransaction({ digest: pending.proposalDigest, timeout: 60_000, pollInterval: 1_000 });
            const receipt = await client.getTransactionBlock({ digest: pending.proposalDigest, options: { showEffects: true, showEvents: true } });
            if (receipt.effects?.status?.status !== "success") throw new Error("The proposal transaction did not finalize successfully");
            const proposed = eventFor(receipt.events ?? [], "::memory::MemoryAccountOwnerRotationProposed");
            if (canonical(String(readEventField(proposed, "account_id", "accountId"))) !== canonical(accountId)
                || canonical(String(readEventField(proposed, "old_owner", "oldOwner"))) !== canonical(pending.oldOwner)
                || canonical(String(readEventField(proposed, "new_owner", "newOwner"))) !== canonical(pending.newOwner)
                || BigInt(String(readEventField(proposed, "agent_count", "agentCount"))) !== BigInt(pending.agentCount)
                || BigInt(String(readEventField(proposed, "organization_count", "organizationCount"))) !== BigInt(pending.organizationCount)) {
                throw new Error("The finalized proposal receipt does not match the saved migration request");
            }
            await verifyScopedMcpReceipt(pending.proposalDigest, "proposal", pending.oldOwner, pending.newOwner, pending);
            const verified = { ...pending, verified: true };
            setPending(verified); localStorage.setItem(`myso-agents:owner-rotation:${canonical(accountId)}`, JSON.stringify(verified));
            setMessage("Proposal receipt verified. The recipient wallet can now accept the migration.");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "The proposal receipt could not be verified");
        } finally { setBusy(false); }
    }

    async function rollbackPendingReferences(signer: string, multisigSigner = false) {
        if (!pending) throw new Error("There is no pending owner migration");
        const progressState = await loadOwnerRotationProgress(client, socialChain, accountId);
        if (progressState.oldOwner !== canonical(pending.oldOwner) || progressState.newOwner !== canonical(pending.newOwner)
            || (canonical(signer) !== progressState.oldOwner && canonical(signer) !== progressState.newOwner)) {
            throw new Error("The live pending migration does not match this account or connected wallet");
        }
        let agents = [...progressState.updatedAgentObjectIds];
        let organizations = [...progressState.updatedOrganizationObjectIds];
        let rollbackBatch = 0;
        while (agents.length > 0 || organizations.length > 0) {
            const agentBatch = agents.splice(0, 6);
            const organizationBatch = organizations.splice(0, Math.max(0, 6 - agentBatch.length));
            rollbackBatch += 1;
            const tx = buildRollbackOwnerRotationBatchTransaction(
                { client, chain: socialChain, accountId, profileId: progressState.profileId },
                progressState, signer, agentBatch, organizationBatch,
            );
            setProgress(`Review rollback batch ${rollbackBatch}: restore ${agentBatch.length} agents and ${organizationBatch.length} organizations…`);
            const bytes = await prepareOwnerRotationTransaction(client, tx, signer);
            let signatureOverride: string | undefined;
            if (multisigSigner) {
                if (!multisigConfig || canonical(multisigConfig.address) !== canonical(signer)) throw new Error("Select the signer set that matches the pending multisig recipient");
                const preparedBase64 = encodeBase64(bytes);
                const combined = await signMySoTransactionWithMultisig({
                    multisig: multisigConfig,
                    transactionBlockBase64: preparedBase64,
                    chain: `myso:${network}`,
                    signers: selectedMultisigMembers.map(({ wallet, account }) => ({
                        wallet,
                        account: { ...account, publicKey: Uint8Array.from(account.publicKey) },
                    })),
                });
                if (combined.bytes !== preparedBase64) throw new Error("The multisig wallets returned different bytes from the prepared rollback batch");
                signatureOverride = combined.signature;
            }
            await executeAndVerify(bytes, signer, (events) => {
                const expected = new Map<string, number>();
                for (const id of agentBatch) expected.set(canonical(id), 1);
                for (const id of organizationBatch) expected.set(canonical(id), 2);
                const references = events.filter((event) => event.type?.endsWith("::memory::MemoryAccountOwnerRotationReferenceUpdated"));
                if (references.length !== expected.size) throw new Error("The rollback receipt updated an unexpected number of references");
                for (const event of references) {
                    const id = canonical(String(readEventField(event, "reference_id", "referenceId")));
                    if (expected.get(id) !== Number(readEventField(event, "reference_kind", "referenceKind"))
                        || canonical(String(readEventField(event, "old_owner", "oldOwner"))) !== canonical(pending.newOwner)
                        || canonical(String(readEventField(event, "new_owner", "newOwner"))) !== canonical(pending.oldOwner)
                        || canonical(String(readEventField(event, "updated_by", "updatedBy"))) !== canonical(signer)) {
                        throw new Error("A rollback event does not match this migration batch");
                    }
                    expected.delete(id);
                }
                if (expected.size) throw new Error("The rollback receipt omitted updated references");
            }, undefined, signatureOverride);
            const latest = await loadOwnerRotationProgress(client, socialChain, accountId);
            if (latest.updatedAgentObjectIds.length !== agents.length || latest.updatedOrganizationObjectIds.length !== organizations.length) {
                throw new Error("The on-chain migration rollback progress does not match the finalized batch; refresh and resume");
            }
            for (const id of latest.updatedAgentObjectIds) if (agentBatch.some((removed) => canonical(removed) === canonical(id))) throw new Error("An agent reference remains marked as updated after rollback");
            for (const id of latest.updatedOrganizationObjectIds) if (organizationBatch.some((removed) => canonical(removed) === canonical(id))) throw new Error("An organization reference remains marked as updated after rollback");
            agents = [...latest.updatedAgentObjectIds];
            organizations = [...latest.updatedOrganizationObjectIds];
        }
        setProgress("");
        return progressState;
    }

    async function rollbackOnly() {
        if (!pending || (!ownerMatches && !pendingRecipientMatches) || (!account?.address && !multisigRecipientMatches)) return;
        setBusy(true); setMessage("");
        try {
            await rollbackPendingReferences(ownerMatches ? ownerAddress : pending!.newOwner, !ownerMatches && multisigRecipientMatches);
            setMessage("All changed references are restored to the current owner. The original owner can now cancel the pending proposal.");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "The migration references could not be rolled back");
        } finally { setBusy(false); }
    }

    async function cancelProposal() {
        if (!pending || !ownerMatches) return;
        setBusy(true); setMessage("");
        try {
            const progressState = await rollbackPendingReferences(ownerAddress);
            const tx = buildCancelOwnerRotationTransaction({ client, chain: socialChain, accountId, profileId: progressState.profileId }, ownerAddress);
            setProgress("All changed references are restored. Review and sign cancellation with the original owner wallet…");
            const bytes = await prepareOwnerRotationTransaction(client, tx, ownerAddress);
            const digest = await executeAndVerify(bytes, ownerAddress, (events) => {
                if (events.some((event) => event.type?.endsWith("::memory::MemoryAccountOwnerRotated")
                    || event.type?.endsWith("::memory::MemoryAccountOwnerRotationReferenceUpdated"))) {
                    throw new Error("The cancellation receipt contains unexpected ownership changes");
                }
            });
            setPending(null); localStorage.removeItem(`myso-agents:owner-rotation:${canonical(accountId)}`);
            setMessage(`The original owner restored changed references and canceled the pending proposal in finalized transaction ${digest}.`);
            setProgress("");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "The owner migration proposal could not be canceled");
        } finally { setBusy(false); }
    }

    const locked = busy || pending !== null;
    function changeMultisigMember(address: string, checked: boolean) {
        const next = checked
            ? selectedMultisigAddresses.some((item) => canonical(item) === canonical(address)) ? selectedMultisigAddresses : [...selectedMultisigAddresses, address]
            : selectedMultisigAddresses.filter((item) => canonical(item) !== canonical(address));
        setSelectedMultisigAddresses(next);
        setMultisigDescriptor(null); setMultisigPrepareError("");
        localStorage.setItem(`myso-agents:owner-multisig:${network}:${canonical(accountId)}`, JSON.stringify({ addresses: next, threshold: multisigThreshold }));
    }
    function changeMultisigThreshold(value: string) {
        setMultisigThreshold(value);
        setMultisigDescriptor(null); setMultisigPrepareError("");
        if (/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 2550) {
            localStorage.setItem(`myso-agents:owner-multisig:${network}:${canonical(accountId)}`, JSON.stringify({ addresses: selectedMultisigAddresses, threshold: value }));
        }
    }
    async function validateMultisigConfiguration() {
        if (!multisigConfig || selectedMultisigMembers.length < 2) return;
        setMultisigPreparing(true); setMultisigPrepareError(""); setMultisigDescriptor(null);
        try {
            const response = await fetch("/api/myso/account/multisig", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                threshold: Number(multisigThreshold),
                members: selectedMultisigMembers.map(member => ({ address: member.address, publicKeyBase64: encodeBase64(member.publicKey), weight: member.weight })),
            }) });
            const result: unknown = await response.json().catch(() => null);
            if (!response.ok || !result || typeof result !== "object") {
                const detail = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "The MCP multisig descriptor could not be prepared";
                throw new Error(detail);
            }
            const descriptor = result as MultisigDescriptor;
            if (descriptor.format !== "myso-protocol-multisig-v1" || canonical(descriptor.address) !== canonical(multisigConfig.address)
                || descriptor.publicKeyBase64 !== encodeBase64(multisigConfig.publicKey.toRawBytes()) || descriptor.threshold !== Number(multisigThreshold)
                || descriptor.members.length !== selectedMultisigMembers.length || descriptor.members.some((member, index) => {
                    const selected = selectedMultisigMembers[index];
                    return !selected || canonical(member.address) !== canonical(selected.address)
                        || member.publicKeyBase64 !== encodeBase64(selected.publicKey) || member.weight !== selected.weight;
                })) throw new Error("The MCP descriptor differs from the locally address-verified wallet signer set");
            setMultisigDescriptor(descriptor);
        } catch (error) { setMultisigPrepareError(error instanceof Error ? error.message : "The multisig configuration could not be validated"); }
        finally { setMultisigPreparing(false); }
    }
    return <section className="myso-create myso-owner-rotation" aria-labelledby="owner-rotation-title">
        <h3 id="owner-rotation-title">Owner wallet migration</h3>
        <p>Move this MySo account to a recipient wallet or protocol multisig. The current owner proposes the change; the recipient wallet or required multisig signers approve every update before the account and linked profile owner change.</p>
        {!chainConfigured ? <p className="myso-knowledge-note" role="status">Owner migration is unavailable until this network’s social MemoryRegistry and UsernameRegistry IDs are supplied by the MySo MCP context.</p> : ownerMatches ? <p className="myso-policy-wallet"><Wallet size={14}/> Current owner wallet connected · {account!.address}</p> : <div className="myso-toolbar">{wallets.map((wallet) => <button key={wallet.name} type="button" className="myso-secondary" disabled={busy || connect.isPending} onClick={() => connect.mutate({ wallet, accountAddress: ownerAddress })}><Wallet size={15}/>{`Connect ${wallet.name}`}</button>)}</div>}
        <details className="myso-multisig-setup">
            <summary>Set up a protocol multisig recipient</summary>
            <p>Select connected wallet accounts to derive a MySo protocol multisig address. To accept a migration to that address, each selected account will be asked to sign the same transaction; no signing key leaves its wallet.</p>
            {wallets.filter((wallet) => wallet.accounts.length === 0).map((wallet) => <button key={wallet.name} type="button" className="myso-secondary" disabled={busy || connect.isPending} onClick={() => connect.mutate({ wallet })}><Wallet size={15}/>Connect {wallet.name} for multisig</button>)}
            {availableMultisigAccounts.length === 0 ? <p className="myso-knowledge-note">Connect the wallets that will participate before configuring the signer set.</p> : <div className="myso-multisig-members">{availableMultisigAccounts.map(({ wallet, address }) => <label key={`${wallet.name}:${address}`}><input type="checkbox" checked={selectedMultisigAddresses.some((item) => canonical(item) === canonical(address))} disabled={busy} onChange={(event) => changeMultisigMember(address, event.target.checked)}/>{wallet.name} · <code>{address}</code></label>)}</div>}
            <label htmlFor="owner-multisig-threshold">Required signer weight</label><input id="owner-multisig-threshold" type="number" min="1" max="2550" step="1" value={multisigThreshold} disabled={busy} onChange={(event) => changeMultisigThreshold(event.target.value)}/>
            {multisigError && <p className="myso-knowledge-note" role="alert">{multisigError}</p>}
            {multisigConfig && <><p className="myso-knowledge-note">Locally derived MySo multisig address: <code>{multisigConfig.address}</code></p><button type="button" className="myso-secondary" disabled={busy || multisigPreparing || selectedMultisigMembers.length < 2} onClick={() => void validateMultisigConfiguration()}>{multisigPreparing ? "Checking MCP descriptor…" : "Validate signer set with MySo MCP"}</button>{multisigPrepareError && <p className="myso-knowledge-note" role="alert">{multisigPrepareError}</p>}{multisigDescriptorMatches && <p className="myso-knowledge-note" role="status">MCP and local SDK agree on the address, public keys, weights and threshold. This descriptor is derived locally; no signer policy is written on chain.</p>}<button type="button" className="myso-secondary" disabled={busy || !!pending || !multisigDescriptorMatches} onClick={() => setNewOwner(multisigConfig!.address)}>Use this address as migration recipient</button></>}
        </details>
        {pending ? <>
            <p className="myso-knowledge-note">{pending.proposalDigest ? <>Proposal {pending.proposalDigest}<br/></> : <>Recovered from the live on-chain migration record<br/></>}Recipient: <code>{pending.newOwner}</code></p>
            <p className="myso-knowledge-note">Manifest: {pending.agentCount} agents · {pending.organizationCount} organizations · {pending.verified ? "on-chain proposal verified" : "proposal receipt needs verification"}</p>
            {recipientMatches ? <p className="myso-policy-wallet"><Wallet size={14}/> Recipient wallet connected · {account!.address}</p> : multisigRecipientMatches ? <p className="myso-policy-wallet"><Wallet size={14}/> Multisig recipient matches the selected signer set</p> : <div className="myso-toolbar">{wallets.map((wallet) => <button key={wallet.name} type="button" className="myso-secondary" disabled={busy || connect.isPending} onClick={() => connect.mutate({ wallet, accountAddress: pending.newOwner })}><Wallet size={15}/>{`Connect ${wallet.name} as recipient`}</button>)}</div>}
            {multisigConfig && canonical(multisigConfig.address) === canonical(pending.newOwner) && <p className="myso-knowledge-note">Matching multisig signer set selected · {multisigConfig.members.length} signers · threshold {multisigConfig.threshold}</p>}
            <div className="myso-toolbar">{!pending.verified&&<button type="button" className="myso-secondary" disabled={busy || !pending.proposalDigest} onClick={() => void verifyPendingProposal()}>{busy?"Checking…":"Verify proposal receipt"}</button>}<button type="button" className="myso-primary" disabled={busy || !chainConfigured || !pending.verified || !pendingRecipientMatches} onClick={() => void acceptProposal()}>{busy ? "Working…" : "Review and accept migration"}<ArrowRight size={15}/></button>{(ownerMatches||pendingRecipientMatches)&&<button type="button" className="myso-secondary" disabled={busy || !chainConfigured} onClick={() => void rollbackOnly()}>Roll back updated references</button>}{ownerMatches&&<button type="button" className="myso-secondary" disabled={busy || !chainConfigured} onClick={() => void cancelProposal()}>Roll back and cancel with original owner</button>}</div>
        </> : <>
            <label htmlFor="owner-rotation-new-owner">Recipient wallet address</label>
            <input id="owner-rotation-new-owner" value={newOwner} onChange={(event) => setNewOwner(event.target.value.trim())} placeholder="0x…" disabled={locked}/>
            <button type="button" className="myso-primary" disabled={busy || !chainConfigured || !ownerMatches || !validNewOwner} onClick={() => void beginProposal()}>{busy ? "Working…" : "Review and propose"}<ArrowRight size={15}/></button>
        </>}
        {manifest && <p className="myso-knowledge-note">Fullnode manifest verified · {manifest.agentCount} agents · {manifest.organizationCount} organizations</p>}
        {progress && <p className="myso-knowledge-note" role="status"><RefreshCw size={14}/> {progress}</p>}
        {message && <p className="myso-knowledge-note" role="status">{message}</p>}
        <MySoTransferableAssets ownerAddress={ownerAddress} network={network}/>
    </section>;
}
