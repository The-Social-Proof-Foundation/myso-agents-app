"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeKeyAddress, type AgentKeyEnvelopeV1 } from "@socialproof/memory";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { useConnectWallet, useCurrentAccount, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { LockKeyhole, Plus, Wallet } from "lucide-react";
import type { ExecutionScope } from "@/src/core";
import { CustodyVault, PRIMARY_CUSTODY } from "@/src/agent/custody-vault";
import { deriveMySocialLoginSeed } from "@/src/agent/custody-session";
import { ACTION_WORKER_ACTIONS, createAutomationDelegate, DelegateMemoryVaultSetupError, initializeDelegateMemoryVault, type AutomationDelegateClass } from "@/src/agent/myso-automation-delegate";

type Props = {
    context: {
        scope: ExecutionScope;
        derivedAddress: string;
        rpcUrl: string;
        socialChain: { packageId: string; memoryConfigId: string; clockId?: string };
    };
    onCreated: () => void;
    onReconnect: () => Promise<void>;
};
const NETWORKS = new Set(["mainnet", "testnet", "devnet", "localnet"]);
const sameAddress = (left: string, right: string) => normalizeKeyAddress(left) === normalizeKeyAddress(right);

async function verifyEnvelope(client: MySoJsonRpcClient, expectedOwner: string, accountId: string, id: string, envelope: AgentKeyEnvelopeV1) {
    const read = async (objectId: string) => {
        const response = await client.getObject({ id: objectId, options: { showContent: true } });
        const content = response.data?.content;
        if (!content || content.dataType !== "moveObject") throw new Error("The agent or account could not be verified on chain");
        return { type: content.type, fields: content.fields as Record<string, unknown> };
    };
    const value = await read(id);
    const [pkg, module, type] = value.type.split("::");
    const fields = value.fields;
    const publicKey = Array.isArray(fields.public_key) ? fields.public_key.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("") : "";
    if (normalizeKeyAddress(pkg ?? "") !== envelope.packageId || module !== "memory" || type !== "SubAgent" || publicKey !== envelope.publicKey || fields.active !== true || normalizeKeyAddress(String(fields.memory_account_id)) !== normalizeKeyAddress(accountId) || normalizeKeyAddress(String(fields.principal_owner)) !== normalizeKeyAddress(expectedOwner) || normalizeKeyAddress(String(fields.derived_address)) !== envelope.derivedAddress) throw new Error("The custody envelope does not match the active on-chain agent");
    const expiry = optionValue(fields.expires_at);
    if (expiry != null && Number(expiry) < Date.now()) throw new Error("The on-chain agent has expired");
    let parent = optionValue(fields.parent_object_id);
    const seen = new Set<string>();
    while (typeof parent === "string" && parent) {
        const parentId = normalizeKeyAddress(parent);
        if (seen.has(parentId) || seen.size >= 8) throw new Error("The on-chain agent ancestry is invalid");
        seen.add(parentId);
        const ancestor = await read(parent);
        const [ancestorPackage, ancestorModule, ancestorType] = ancestor.type.split("::");
        if (normalizeKeyAddress(ancestorPackage ?? "") !== envelope.packageId || ancestorModule !== "memory" || ancestorType !== "SubAgent" || ancestor.fields.active !== true || normalizeKeyAddress(String(ancestor.fields.memory_account_id)) !== normalizeKeyAddress(accountId) || normalizeKeyAddress(String(ancestor.fields.principal_owner)) !== normalizeKeyAddress(expectedOwner)) throw new Error("An ancestor agent is inactive or belongs to a different account");
        const ancestorExpiry = optionValue(ancestor.fields.expires_at);
        if (ancestorExpiry != null && Number(ancestorExpiry) < Date.now()) throw new Error("An ancestor agent has expired");
        parent = optionValue(ancestor.fields.parent_object_id);
    }
    const account = await read(accountId);
    if (account.fields.active !== true || normalizeKeyAddress(String(account.fields.owner)) !== normalizeKeyAddress(expectedOwner)) throw new Error("The Memory account is inactive or its owner changed");
    return { platformScope: optionValue(fields.platform_scope) as string | null };
}
function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
function optionValue(value: unknown): unknown {
    if (value == null || typeof value === "string" || typeof value === "number") return value ?? null;
    if (typeof value === "object" && !Array.isArray(value)) {
        const record = value as { vec?: unknown; fields?: { vec?: unknown } };
        const vector = record.vec ?? record.fields?.vec;
        if (Array.isArray(vector) && vector.length <= 1) return vector[0] ?? null;
    }
    throw new Error("The on-chain agent has an invalid optional field");
}

export function MySoAutomationDelegateSetup({ context, onCreated, onReconnect }: Props) {
    const account = useCurrentAccount();
    const wallets = useWallets();
    const connect = useConnectWallet();
    const personal = useSignPersonalMessage();
    const transaction = useSignTransaction();
    const signMessageRef = useRef(personal.mutateAsync);
    signMessageRef.current = personal.mutateAsync;
    const memoryUrl = process.env.NEXT_PUBLIC_MYSO_MEMORY_URL;
    const network = NETWORKS.has(context.scope.network) ? context.scope.network as "mainnet" | "testnet" | "devnet" | "localnet" : null;
    const client = useMemo(() => network ? new MySoJsonRpcClient({ url: context.rpcUrl, network }) : null, [network, context.rpcUrl]);
    const vault = useMemo(() => {
        if (!memoryUrl || !client) return null;
        const instance = new CustodyVault(memoryUrl, { accountId: context.scope.accountId, owner: context.scope.owner }, async (message) => {
            if (!account || !sameAddress(account.address, context.scope.owner)) throw new Error("Connect the owner wallet to unlock local agent custody");
            const signed = await signMessageRef.current({ message, chain: `myso:${context.scope.network}` });
            return signed.signature;
        }, (agentId, envelope) => verifyEnvelope(client, context.scope.owner, context.scope.accountId, agentId, envelope));
        instance.setLoginSeedProvider(deriveMySocialLoginSeed);
        return instance;
    }, [memoryUrl, client, context.scope.accountId, context.scope.owner, context.scope.network, account]);
    const [snapshot, setSnapshot] = useState(0);
    const [name, setName] = useState("");
    const [delegateClass, setDelegateClass] = useState<AutomationDelegateClass>("memory");
    const [allowedActionIds, setAllowedActionIds] = useState<string[]>([]);
    const [expiryDays, setExpiryDays] = useState(30);
    const [spendCap, setSpendCap] = useState("0");
    const [pendingMemoryVaultAgent, setPendingMemoryVaultAgent] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    useEffect(() => {
        if (!vault) return;
        const unsubscribe = vault.subscribe(() => setSnapshot(vault.getSnapshot()));
        return () => { unsubscribe(); vault.lock(); };
    }, [vault]);
    void snapshot;
    async function unlock() {
        if (!vault) return;
        setBusy(true); setMessage("Unlocking the local custody vault…");
        try { await vault.unlock({ method: PRIMARY_CUSTODY }); setMessage("Custody vault unlocked on this device. It will lock when you leave this screen."); }
        catch (error) { setMessage(error instanceof Error ? error.message : "The custody vault could not be unlocked"); }
        finally { setBusy(false); }
    }
    async function create() {
        if (!vault || !client || !account || !sameAddress(account.address, context.scope.owner)) return;
        setBusy(true); setMessage("Checking parent authority…");
        try {
            const result = await createAutomationDelegate({
                context: { accountId: context.scope.accountId, agentId: context.scope.agentId, derivedAddress: context.derivedAddress, owner: context.scope.owner, network: context.scope.network, rpcUrl: context.rpcUrl, socialChain: context.socialChain },
                client, vault, name, delegateClass, allowedActionIds, expiryDays, maxActionSpendMist: spendCap,
                signOwnerPersonalMessage: async (bytes) => (await signMessageRef.current({ message: bytes, chain: `myso:${context.scope.network}` })).signature,
                signOwnerTransaction: async (bytes) => (await transaction.mutateAsync({ transaction: toBase64(bytes), chain: `myso:${context.scope.network}` })).signature,
                onStep: setMessage,
            });
            setMessage(`Delegate ${result.agentObjectId} registered, its key encrypted, and memory vault initialized. Transaction ${result.digest}.`);
            setName("");
            onCreated();
        } catch (error) {
            if (error instanceof DelegateMemoryVaultSetupError) { setPendingMemoryVaultAgent(error.agentObjectId); onCreated(); }
            setMessage(error instanceof Error ? error.message : "The delegate could not be registered");
        }
        finally { setBusy(false); }
    }
    async function retryMemoryVaultSetup() {
        if (!client || !pendingMemoryVaultAgent || !walletMatches) return;
        setBusy(true);setMessage("Verifying the registered child before retrying memory-vault setup…");
        try {
            await initializeDelegateMemoryVault({
                context: {accountId:context.scope.accountId,agentId:context.scope.agentId,derivedAddress:context.derivedAddress,owner:context.scope.owner,network:context.scope.network,rpcUrl:context.rpcUrl,socialChain:context.socialChain},
                client,agentObjectId:pendingMemoryVaultAgent,
                signOwnerTransaction:async bytes=>(await transaction.mutateAsync({transaction:toBase64(bytes),chain:`myso:${context.scope.network}`})).signature,
            });
            setMessage(`Memory vault initialized for ${pendingMemoryVaultAgent}.`);setPendingMemoryVaultAgent(null);onCreated();
        }catch(error){setMessage(error instanceof Error?error.message:"Memory-vault setup retry failed");}
        finally{setBusy(false);}
    }
    const walletMatches = !!account && sameAddress(account.address, context.scope.owner);
    return <section className="myso-settlement-receipt" aria-label="Create an automation delegate">
        <h2>Register an automation delegate</h2>
        <p>Creates a bounded child beneath the connected agent. The parent key stays in this device’s custody vault; the automation bridge receives only the encrypted child key.</p>
        {!memoryUrl && <p className="myso-error" role="alert">Set NEXT_PUBLIC_MYSO_MEMORY_URL to enable encrypted agent-key custody.</p>}
        {account && !walletMatches && <p className="myso-error" role="alert">Connect the MySo owner wallet for {context.scope.owner} before creating a delegate.</p>}
        {!walletMatches && <div className="myso-toolbar">{wallets.map((wallet) => <button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending || busy} onClick={() => void connect.mutateAsync({ wallet, accountAddress: context.scope.owner }).catch((error) => setMessage(error instanceof Error ? error.message : "Wallet connection failed"))}><Wallet size={16}/>{connect.isPending ? "Connecting…" : `Connect ${wallet.name}`}</button>)}</div>}
        {vault?.status !== "ready" ? <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={!vault || !walletMatches || busy} onClick={() => void unlock()}><LockKeyhole size={16}/>{busy ? "Unlocking…" : "Unlock local custody vault"}</button><button type="button" className="myso-secondary" disabled={busy} onClick={() => void onReconnect().catch((error) => setMessage(error instanceof Error ? error.message : "MySocial reconnection failed"))}>Refresh MySocial custody session</button></div> : <>
            <label htmlFor="automation-delegate-name">Delegate name</label><input id="automation-delegate-name" maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. task-runner" />
            <label htmlFor="automation-delegate-class">Permissions</label><select id="automation-delegate-class" value={delegateClass} onChange={(event) => { setDelegateClass(event.target.value as AutomationDelegateClass); setAllowedActionIds([]); }}><option value="memory">Memory only</option><option value="task_worker">Task worker (memory and task market)</option><option value="juror">Juror (no spending)</option><option value="action_worker">Action worker (selected MySocial actions)</option></select>
            {delegateClass === "action_worker" && <fieldset className="myso-inline-choice"><legend>Actions this worker may run (choose up to 16)</legend>{ACTION_WORKER_ACTIONS.map((id) => <label key={id} className="myso-check-row"><input type="checkbox" checked={allowedActionIds.includes(id)} disabled={!allowedActionIds.includes(id) && allowedActionIds.length >= 16} onChange={(event) => setAllowedActionIds(current => event.target.checked ? [...current, id] : current.filter(item => item !== id))}/><span>{id}</span></label>)}<small>Only registered agent-capability actions are offered. Actions requiring an owner wallet signature remain unavailable to unattended workers.</small></fieldset>}
            <label htmlFor="automation-delegate-expiry">Expires in days (1–90)</label><input id="automation-delegate-expiry" type="number" min={1} max={90} value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}/>
            <label htmlFor="automation-delegate-spend">Maximum per-action spend in MIST</label><input id="automation-delegate-spend" inputMode="numeric" pattern="[0-9]*" value={spendCap} disabled={delegateClass === "juror"} onChange={(event) => setSpendCap(event.target.value)}/>
            <button type="button" className="myso-primary" disabled={busy || !name.trim() || !walletMatches || !client || !network || (delegateClass === "action_worker" && allowedActionIds.length === 0)} onClick={() => void create()}><Plus size={16}/>{busy ? "Registering delegate…" : "Register and encrypt key"}</button>
        </>}
        {pendingMemoryVaultAgent&&<div><p>The delegate and encrypted key are saved. Its memory vault still needs owner-wallet setup.</p><button type="button" className="myso-secondary" disabled={busy||!walletMatches} onClick={()=>void retryMemoryVaultSetup()}>Retry memory-vault setup for {pendingMemoryVaultAgent.slice(0,12)}…</button></div>}
        {message && <p className="myso-knowledge-note" aria-live="polite">{message}</p>}
    </section>;
}
