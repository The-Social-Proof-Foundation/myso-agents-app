import { Transaction } from "@socialproof/myso/transactions";
import { MYSO_CLOCK_OBJECT_ID } from "@socialproof/myso/utils";
import type { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import type { CustodyVault } from "./custody-vault";
import { encryptAutomationDelegateSeed, generateAutomationDelegateSeed, parseMyDataEncryptionKeys, type MyDataEncryptionKey } from "./automation-delegate";

export type AutomationDelegateClass = "memory" | "task_worker" | "juror" | "action_worker";
export const ACTION_WORKER_ACTIONS = [
    "access.publish_mydata_graph.v1", "access.purchase_mydata_access.v1", "access.purchase_post_access.v1",
    "task.create.v1", "spt.buy.v1",
    "social.react_to_post.v1", "social.remove_post_reaction.v1",
    "social.react_to_comment.v1", "social.remove_comment_reaction.v1", "social.create_post.v1",
    "social.edit_post.v1", "social.create_comment.v1", "social.edit_comment.v1", "social.create_repost.v1",
    "social.remove_repost.v1", "social.follow_profile.v1", "social.unfollow_profile.v1", "social.block_profile.v1",
    "social.unblock_profile.v1", "messaging.send_message.v1", "messaging.create_group.v1", "messaging.bind_room_to_task.v1",
    "organization.accept_invitation.v1", "organization.decline_invitation.v1", "agent.register_child.v1",
    "agent.update_child.v1", "agent.deactivate_child.v1", "agent.revoke_child.v1",
] as const;
export type ActionWorkerActionId = (typeof ACTION_WORKER_ACTIONS)[number];
export interface DelegateChainContext {
    accountId: string;
    agentId: string;
    derivedAddress: string;
    owner: string;
    network: string;
    rpcUrl: string;
    socialChain: { packageId: string; memoryConfigId: string; clockId?: string };
}
type Authority = {
    agent: {
        agentObjectId: string;
        active: boolean;
        expectedCapabilities: string;
        expectedLimitMist: string | "unlimited";
        delegatableCaps: string;
        expectedPlatformScope: string | null;
        organizationId: string | null;
        expiresAtMs: string | null;
        effectiveAuthority: {
            activeNow: boolean;
            accountActive: boolean;
            effectiveExecutionCapabilitiesMask: string;
            effectivePerActionSpendLimitMist: string | "unlimited";
            activeChain: Array<{ expiresAtMs: string | null }>;
        };
    };
};
const CAP = { MEMORY_READ: 1, MEMORY_WRITE: 2, MYDATA_READ: 4, TRADE_EXECUTE: 256, TASK_TRADE: 131072, JURY: 262144, AGENT_REGISTER: 8192 } as const;
const TASK_ACTION_IDS = ["task.create.v1", "task.accept.v1", "task.decline.v1", "task.cancel_offer.v1", "task.deliver.v1", "task.settle.v1", "task.refund.v1", "task.release.v1", "task.expire_offer.v1", "task.propose_refund.v1", "task.accept_refund.v1", "task.reject_refund.v1", "task.withdraw_refund.v1", "task.review.v1"];
const JUROR_ACTION_IDS = ["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"];
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 60 * 1000;
const normalizeId = (value: string) => `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;

function classPolicy(delegateClass: AutomationDelegateClass, selectedActionIds: readonly string[] = []) {
    if (delegateClass === "task_worker") return { capabilities: CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ | CAP.TASK_TRADE, actions: TASK_ACTION_IDS };
    if (delegateClass === "juror") return { capabilities: CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ | CAP.JURY, actions: JUROR_ACTION_IDS };
    if (delegateClass === "action_worker") {
        if (selectedActionIds.length < 1 || selectedActionIds.length > 16 || new Set(selectedActionIds).size !== selectedActionIds.length
            || selectedActionIds.some((id) => !(ACTION_WORKER_ACTIONS as readonly string[]).includes(id))) {
            throw new Error("Choose 1–16 distinct supported actions for this action worker");
        }
        const actionCaps = selectedActionIds.reduce((caps, id) => caps | (
            id.startsWith("access.") ? CAP.MYDATA_READ
                : id === "task.create.v1" ? CAP.TASK_TRADE
                    : id === "spt.buy.v1" ? CAP.TRADE_EXECUTE
                : id.startsWith("social.react_") || id.startsWith("social.remove_") ? 1024
                    : id.startsWith("social.follow_") || id.startsWith("social.unfollow_") || id.startsWith("social.block_") || id.startsWith("social.unblock_") ? 65536
                        : id.startsWith("social.create_comment") || id.startsWith("social.edit_comment") ? 512
                            : id.startsWith("social.create_post") || id.startsWith("social.edit_post") || id.startsWith("social.create_repost") || id.startsWith("social.remove_repost") ? 16
                            : id.startsWith("messaging.") ? 64
                                : id === "organization.accept_invitation.v1" || id === "organization.decline_invitation.v1" ? CAP.MEMORY_READ
                                    : id === "agent.register_child.v1" ? CAP.AGENT_REGISTER
                                        : id === "agent.update_child.v1" ? 4096
                                            : id === "agent.deactivate_child.v1" || id === "agent.revoke_child.v1" ? 2048
                                                : 0
        ), 0);
        return { capabilities: CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ | actionCaps, actions: [...selectedActionIds] };
    }
    return { capabilities: CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ, actions: [] as string[] };
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "The delegate operation could not continue");
    return data;
}
async function getObject(client: MySoJsonRpcClient, id: string) {
    const response = await client.getObject({ id, options: { showContent: true } });
    const content = response.data?.content;
    if (!content || content.dataType !== "moveObject") throw new Error("The chain object needed for delegate verification is unavailable");
    return { type: content.type, fields: content.fields as Record<string, unknown> };
}
function optionValue(value: unknown): unknown {
    if (value == null) return null;
    if (typeof value === "string" || typeof value === "number") return value;
    if (typeof value === "object" && !Array.isArray(value)) {
        const vector = (value as { vec?: unknown; fields?: { vec?: unknown } }).vec ?? (value as { fields?: { vec?: unknown } }).fields?.vec;
        if (Array.isArray(vector) && vector.length <= 1) return vector[0] ?? null;
    }
    throw new Error("The parent agent policy returned an invalid optional field");
}
function readAuthority(value: unknown, expectedId: string): Authority {
    if (!value || typeof value !== "object") throw new Error("The parent agent's live policy is unavailable");
    const row = value as Authority;
    if (!row.agent || normalizeId(row.agent.agentObjectId) !== normalizeId(expectedId) || !row.agent.effectiveAuthority?.activeNow || !row.agent.effectiveAuthority.accountActive || !row.agent.active) {
        throw new Error("The parent agent or one of its ancestors is inactive or expired");
    }
    return row;
}
async function ownerCoin(client: MySoJsonRpcClient, owner: string) {
    const page = await client.getCoins({ owner, coinType: "0x2::myso::MYSO", limit: 50 });
    const coin = page.data.filter((item) => BigInt(item.balance) >= 50_000_000n).sort((a, b) => BigInt(a.balance) > BigInt(b.balance) ? -1 : 1)[0];
    if (!coin) throw new Error("Connect an owner wallet with one MYSO coin holding enough balance for transaction gas");
    return { objectId: coin.coinObjectId, version: coin.version, digest: coin.digest };
}
async function executeOwnerTx(client: MySoJsonRpcClient, tx: Transaction, owner: string, signOwner: (bytes: Uint8Array) => Promise<string>) {
    tx.setSender(owner);
    tx.setGasOwner(owner);
    tx.setGasPayment([await ownerCoin(client, owner)]);
    tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client });
    const signature = await signOwner(bytes);
    const submitted = await client.executeTransactionBlock({ transactionBlock: bytes, signature, options: { showEffects: true, showObjectChanges: true, showEvents: true } });
    if (submitted.effects?.status.status !== "success") throw new Error(submitted.effects?.status.error ?? "The owner-approved setup transaction failed");
    await client.waitForTransaction({ digest: submitted.digest, timeout: 60_000, pollInterval: 1_000 });
    return submitted;
}

export class DelegateMemoryVaultSetupError extends Error {
    constructor(readonly agentObjectId: string, message: string) { super(message); }
}

async function assertDelegateNameAvailable(name: string): Promise<void> {
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const query: URLSearchParams = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
        const delegatePage: { items: Array<{ delegate_ref: string }>; hasNextPage: boolean; nextCursor: string | null } = await json<{ items: Array<{ delegate_ref: string }>; hasNextPage: boolean; nextCursor: string | null }>(`/api/myso/automations/delegates?${query}`);
        if (delegatePage.items.some((item: { delegate_ref: string }) => item.delegate_ref === name)) throw new Error("That delegate name is already in use. Choose a new name so an existing on-chain delegate cannot be orphaned.");
        if (!delegatePage.hasNextPage) return;
        if (!delegatePage.nextCursor || delegatePage.nextCursor === cursor) throw new Error("Automation delegate pagination returned an invalid cursor");
        cursor = delegatePage.nextCursor;
    }
    throw new Error("Delegate names could not be checked completely; no child was registered");
}

export async function initializeDelegateMemoryVault(input: {
    context: DelegateChainContext;
    client: MySoJsonRpcClient;
    agentObjectId: string;
    signOwnerTransaction: (bytes: Uint8Array) => Promise<string>;
}): Promise<string> {
    const child = await getObject(input.client, input.agentObjectId);
    const fields = child.fields;
    if (!child.type.endsWith("::memory::SubAgent") || normalizeId(String(fields.memory_account_id)) !== normalizeId(input.context.accountId)
        || normalizeId(String(fields.principal_owner)) !== normalizeId(input.context.owner)
        || normalizeId(String(optionValue(fields.parent_object_id) ?? "")) !== normalizeId(input.context.agentId)
        || fields.active !== true) throw new Error("The requested child is not an active child of this account's connected agent");
    const tx = new Transaction();
    tx.moveCall({ target: `${input.context.socialChain.packageId}::memory::ensure_agent_memory_vault`, arguments: [tx.object(input.context.accountId), tx.object(input.agentObjectId), tx.object(input.context.socialChain.clockId ?? MYSO_CLOCK_OBJECT_ID)] });
    const result = await executeOwnerTx(input.client, tx, input.context.owner, input.signOwnerTransaction);
    return result.digest;
}

/** Register a bounded child with the parent key held only in the local custody vault. */
export async function createAutomationDelegate(input: {
    context: DelegateChainContext;
    client: MySoJsonRpcClient;
    vault: CustodyVault;
    name: string;
    delegateClass: AutomationDelegateClass;
    allowedActionIds?: readonly string[];
    expiryDays: number;
    maxActionSpendMist: string;
    signOwnerPersonalMessage: (bytes: Uint8Array) => Promise<string>;
    signOwnerTransaction: (bytes: Uint8Array) => Promise<string>;
    onStep?: (step: string) => void;
}): Promise<{ agentObjectId: string; digest: string; delegateRef: string }> {
    const name = input.name.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("Use 1–64 letters, numbers, dots, underscores or hyphens for the delegate name");
    if (!Number.isInteger(input.expiryDays) || input.expiryDays < 1 || input.expiryDays > 90) throw new Error("Delegate expiry must be from 1 to 90 days");
    if (!/^(0|[1-9][0-9]*)$/.test(input.maxActionSpendMist) || BigInt(input.maxActionSpendMist) > 18446744073709551615n) throw new Error("Enter a valid per-action MYSO spend cap in MIST");
    if (input.delegateClass === "juror" && BigInt(input.maxActionSpendMist) !== 0n) throw new Error("Juror delegates cannot spend MYSO");
    if ((input.delegateClass === "task_worker" || input.delegateClass === "action_worker") && BigInt(input.maxActionSpendMist) === 0n) throw new Error("A chain action worker needs a positive per-action MYSO limit");
    await assertDelegateNameAvailable(name);
    const parentObject = await getObject(input.client, input.context.agentId);
    const fields = parentObject.fields;
    const organizationId = optionValue(fields.organization_id);
    const derivedAddress = fields.derived_address;
    if (typeof organizationId !== "string" || typeof derivedAddress !== "string" || normalizeId(derivedAddress) !== normalizeId(input.context.derivedAddress)) throw new Error("The authenticated parent agent does not match its live chain object");
    const parent = { agent_object_id: input.context.agentId, derived_address: derivedAddress, organization_id: organizationId };
    const quote = readAuthority(await json<unknown>(`/api/myso/agents/${encodeURIComponent(input.context.agentId)}/authority`), input.context.agentId);
    const policy = classPolicy(input.delegateClass, input.allowedActionIds);
    const parentCaps = BigInt(quote.agent.expectedCapabilities);
    const effectiveParentCaps = BigInt(quote.agent.effectiveAuthority.effectiveExecutionCapabilitiesMask);
    const delegatable = BigInt(quote.agent.delegatableCaps);
    if ((parentCaps & BigInt(CAP.AGENT_REGISTER)) === 0n || (effectiveParentCaps & BigInt(CAP.AGENT_REGISTER)) === 0n || (delegatable & BigInt(policy.capabilities)) !== BigInt(policy.capabilities)) {
        throw new Error("The parent agent must be allowed to register children and delegate every capability required by this automation class");
    }
    const parentLimit = quote.agent.effectiveAuthority.effectivePerActionSpendLimitMist;
    const spend = BigInt(input.maxActionSpendMist);
    if (parentLimit !== "unlimited" && spend > BigInt(parentLimit)) throw new Error(`The delegate cap cannot exceed the parent's current per-action limit (${parentLimit} MIST)`);
    const ownLimit = quote.agent.expectedLimitMist;
    if (ownLimit !== "unlimited" && spend > BigInt(ownLimit)) throw new Error(`The delegate cap cannot exceed this agent's own configured limit (${ownLimit} MIST)`);
    const now = Date.now();
    const parentExpiry = [quote.agent.expiresAtMs, ...quote.agent.effectiveAuthority.activeChain.map((agent) => agent.expiresAtMs)]
        .filter((expiry): expiry is string => expiry !== null)
        .reduce((earliest, expiry) => Math.min(earliest, Number(expiry)), Infinity);
    const expiresAtMs = Math.min(now + Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, input.expiryDays * 24 * 60 * 60 * 1000)), parentExpiry);
    if (expiresAtMs <= now) throw new Error("The parent agent expires before this delegate can be registered");
    const bridgeKeys = parseMyDataEncryptionKeys(await json<unknown>("/api/myso/automations/delegates/keys"));
    const delegate = await generateAutomationDelegateSeed();
    let parentKey: Awaited<ReturnType<CustodyVault["getAgent"]>> | null = null;
    try {
        input.onStep?.("Unlocking the parent agent key from local custody…");
        parentKey = await input.vault.getAgent(parent);
        if (normalizeId(parentKey.address) !== normalizeId(derivedAddress)) throw new Error("The custody vault key does not match the parent agent's live derived address");
        const transaction = new Transaction();
        transaction.moveCall({
            target: `${input.context.socialChain.packageId}::memory::register_sub_agent_delegated`,
            arguments: [
                transaction.object(input.context.socialChain.memoryConfigId), transaction.object(input.context.accountId), transaction.object(input.context.agentId),
                transaction.pure.vector("u8", Array.from(delegate.publicKey)), transaction.pure.address(delegate.address), transaction.pure.string(`automation:${name}`),
                transaction.pure.u8(1), transaction.pure.u64("0"), transaction.pure.u64(policy.capabilities), transaction.pure.u64("0"), transaction.pure.u8(3),
                transaction.pure.u64("0"), transaction.pure.option("u64", input.maxActionSpendMist),
                transaction.pure.option("address", quote.agent.expectedPlatformScope), transaction.pure.option("u64", String(Math.floor(expiresAtMs))),
                transaction.pure.u8(1), transaction.object(input.context.socialChain.clockId ?? MYSO_CLOCK_OBJECT_ID),
            ],
        });
        transaction.setSender(parentKey.address);
        transaction.setGasOwner(input.context.owner);
        transaction.setGasPayment([await ownerCoin(input.client, input.context.owner)]);
        transaction.setGasBudget(50_000_000);
        input.onStep?.("Sign the bounded registration with the parent key and your wallet's gas approval…");
        const bytes = await transaction.build({ client: input.client });
        const parentSignature = await parentKey.keypair.signTransaction(bytes);
        const ownerSignature = await input.signOwnerTransaction(bytes);
        const submitted = await input.client.executeTransactionBlock({ transactionBlock: bytes, signature: [parentSignature.signature, ownerSignature], options: { showEffects: true, showObjectChanges: true, showEvents: true } });
        if (submitted.effects?.status.status !== "success") throw new Error(submitted.effects?.status.error ?? "The parent-signed delegate registration failed");
        await input.client.waitForTransaction({ digest: submitted.digest, timeout: 60_000, pollInterval: 1_000 });
        const created = submitted.objectChanges?.find((change) => change.type === "created" && change.objectType?.endsWith("::memory::SubAgent"));
        if (!created || !("objectId" in created)) throw new Error(`The delegate transaction finalized (${submitted.digest}) but its SubAgent object was not returned`);
        const agentObjectId = created.objectId;
        input.onStep?.("Encrypting the new key to the selected MyData bridge key…");
        const recipient: MyDataEncryptionKey = bridgeKeys[0]!;
        const delegateRef = name;
        const encrypted_key = await encryptAutomationDelegateSeed(delegate.seed, recipient, input.context.accountId, delegateRef, agentObjectId);
        await json("/api/myso/automations/delegates", { method: "POST", body: JSON.stringify({
            delegateRef, delegate: {
                agent_object_id: agentObjectId, mydata_key_id: recipient.id, encrypted_key,
                delegate_class: input.delegateClass, allowed_action_ids: policy.actions,
            },
        }) });
        input.onStep?.("Creating the child agent's on-chain memory vault…");
        try { await initializeDelegateMemoryVault({ context: input.context, client: input.client, agentObjectId, signOwnerTransaction: input.signOwnerTransaction }); }
        catch (error) { throw new DelegateMemoryVaultSetupError(agentObjectId, `Delegate ${agentObjectId} is registered and its encrypted key is stored, but memory-vault setup needs retry: ${error instanceof Error ? error.message : "unknown failure"}`); }
        return { agentObjectId, digest: submitted.digest, delegateRef };
    } finally {
        delegate.seed.fill(0);
        parentKey?.seed.fill(0);
        input.vault.lock();
    }
}
