import { Transaction } from "@socialproof/myso/transactions";
import type { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";

export type OwnerRotationKind = "agents" | "organizations";

export interface OwnerRotationChainConfig {
    packageId: string;
    usernameRegistryId: string;
    memoryRegistryId: string;
    clockId?: string;
}

export interface OwnerRotationTxContext {
    client: MySoJsonRpcClient;
    chain: OwnerRotationChainConfig;
    accountId: string;
    profileId: string;
}

export interface OwnerRotationPage {
    kind: OwnerRotationKind;
    accountId: string;
    owner: string;
    profileId: string;
    tableCount: string;
    items: string[];
    hasNextPage: boolean;
    nextCursor: string | null;
    evidenceSource: "configured_fullnode";
}

export interface CompleteOwnerRotationManifest {
    accountId: string;
    owner: string;
    profileId: string;
    agentObjectIds: string[];
    organizationObjectIds: string[];
    agentCount: string;
    organizationCount: string;
    evidenceSource: "configured_fullnode";
}

export interface PendingOwnerRotation {
    accountId: string;
    oldOwner: string;
    newOwner: string;
    agentCount: string;
    organizationCount: string;
    proposedAtMs: string;
}

export interface OwnerRotationProgress extends PendingOwnerRotation {
    profileId: string;
    agentObjectIds: string[];
    organizationObjectIds: string[];
    updatedAgentObjectIds: string[];
    updatedOrganizationObjectIds: string[];
}

const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const MYSO = "0x2::myso::MYSO";

function objectId(value: string, label: string): string {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} is not a MySo object ID`);
    return value;
}

function typedIds(tx: Transaction, ids: string[]): any {
    // ID is a one-address Move wrapper, so its vector has the same BCS bytes as vector<address>.
    return tx.pure("vector<address>", ids.map((id) => objectId(id, "manifest object ID")));
}

function buildBase(context: OwnerRotationTxContext, sender: string): Transaction {
    objectId(context.accountId, "memory account ID");
    objectId(context.profileId, "profile ID");
    objectId(context.chain.usernameRegistryId, "username registry ID");
    objectId(context.chain.memoryRegistryId, "memory registry ID");
    const tx = new Transaction();
    tx.setSender(objectId(sender, "transaction sender"));
    tx.setGasOwner(sender);
    return tx;
}

function assertCompleteManifest(manifest: CompleteOwnerRotationManifest): void {
    const agents = new Set(manifest.agentObjectIds.map(canonicalAddress));
    const organizations = new Set(manifest.organizationObjectIds.map(canonicalAddress));
    if (agents.size !== manifest.agentObjectIds.length || organizations.size !== manifest.organizationObjectIds.length
        || BigInt(manifest.agentCount) !== BigInt(agents.size)
        || BigInt(manifest.organizationCount) !== BigInt(organizations.size)) {
        throw new Error("The owner rotation manifest is incomplete or contains duplicate objects");
    }
}

export function buildProposeOwnerRotationTransaction(
    context: OwnerRotationTxContext,
    manifest: CompleteOwnerRotationManifest,
    newOwner: string,
): Transaction {
    assertCompleteManifest(manifest);
    if (canonicalAddress(manifest.accountId) !== canonicalAddress(context.accountId)
        || canonicalAddress(manifest.profileId) !== canonicalAddress(context.profileId)
        || canonicalAddress(manifest.owner) === canonicalAddress(newOwner)) {
        throw new Error("The migration recipient or account does not match the current manifest");
    }
    const tx = buildBase(context, manifest.owner);
    tx.moveCall({
        target: `${context.chain.packageId}::profile::propose_owner_rotation`,
        arguments: [
            tx.object(context.chain.usernameRegistryId), tx.object(context.chain.memoryRegistryId),
            tx.object(context.accountId), tx.object(context.profileId),
            tx.pure("address", objectId(newOwner, "new owner")),
            typedIds(tx, manifest.agentObjectIds), typedIds(tx, manifest.organizationObjectIds),
            tx.object(context.chain.clockId ?? CLOCK),
        ],
    });
    return tx;
}

export function buildAcceptOwnerRotationTransaction(
    context: OwnerRotationTxContext,
    manifest: CompleteOwnerRotationManifest,
    recipient: string,
): Transaction {
    return buildAcceptOwnerRotationBatchTransaction(context, manifest, recipient, manifest.agentObjectIds, manifest.organizationObjectIds, true);
}

export function buildAcceptOwnerRotationBatchTransaction(
    context: OwnerRotationTxContext,
    manifest: CompleteOwnerRotationManifest,
    recipient: string,
    agentIds: string[],
    organizationIds: string[],
    finalize: boolean,
): Transaction {
    assertCompleteManifest(manifest);
    if (canonicalAddress(manifest.accountId) !== canonicalAddress(context.accountId)
        || canonicalAddress(manifest.profileId) !== canonicalAddress(context.profileId)) {
        throw new Error("The owner rotation manifest does not match this account");
    }
    const registeredAgents = new Set(manifest.agentObjectIds.map(canonicalAddress));
    const registeredOrganizations = new Set(manifest.organizationObjectIds.map(canonicalAddress));
    if (new Set(agentIds.map(canonicalAddress)).size !== agentIds.length
        || new Set(organizationIds.map(canonicalAddress)).size !== organizationIds.length
        || agentIds.some((id) => !registeredAgents.has(canonicalAddress(id)))
        || organizationIds.some((id) => !registeredOrganizations.has(canonicalAddress(id)))) {
        throw new Error("The owner migration batch contains an object outside the complete manifest");
    }
    const tx = buildBase(context, recipient);
    const account = tx.object(context.accountId);
    for (const agentId of agentIds) {
        tx.moveCall({
            target: `${context.chain.packageId}::memory::accept_agent_owner_rotation_reference`,
            arguments: [account, tx.object(objectId(agentId, "agent object ID")), tx.object(context.chain.clockId ?? CLOCK)],
        });
    }
    for (const organizationId of organizationIds) {
        tx.moveCall({
            target: `${context.chain.packageId}::memory::accept_organization_owner_rotation_reference`,
            arguments: [account, tx.object(objectId(organizationId, "organization object ID")), tx.object(context.chain.clockId ?? CLOCK)],
        });
    }
    if (finalize) {
        tx.moveCall({
            target: `${context.chain.packageId}::profile::accept_owner_rotation`,
            arguments: [
                tx.object(context.chain.usernameRegistryId), tx.object(context.chain.memoryRegistryId),
                account, tx.object(context.profileId), tx.object(context.chain.clockId ?? CLOCK),
            ],
        });
    }
    return tx;
}

export function buildCancelOwnerRotationTransaction(context: OwnerRotationTxContext, oldOwner: string): Transaction {
    const tx = buildBase(context, oldOwner);
    tx.moveCall({ target: `${context.chain.packageId}::memory::cancel_owner_rotation`, arguments: [tx.object(context.accountId)] });
    return tx;
}

/** Rolls back only references proven to be in the pending recipient-updated tables. */
export function buildRollbackOwnerRotationBatchTransaction(
    context: OwnerRotationTxContext,
    progress: OwnerRotationProgress,
    sender: string,
    agentIds: string[],
    organizationIds: string[],
): Transaction {
    if (canonicalAddress(progress.accountId) !== canonicalAddress(context.accountId)
        || canonicalAddress(progress.oldOwner) === canonicalAddress(progress.newOwner)) {
        throw new Error("The rollback state does not match this account migration");
    }
    const updatedAgents = new Set(progress.updatedAgentObjectIds.map(canonicalAddress));
    const updatedOrganizations = new Set(progress.updatedOrganizationObjectIds.map(canonicalAddress));
    if (new Set(agentIds.map(canonicalAddress)).size !== agentIds.length
        || new Set(organizationIds.map(canonicalAddress)).size !== organizationIds.length
        || agentIds.some((id) => !updatedAgents.has(canonicalAddress(id)))
        || organizationIds.some((id) => !updatedOrganizations.has(canonicalAddress(id)))) {
        throw new Error("The rollback batch contains a reference not recorded as updated on chain");
    }
    const tx = buildBase(context, sender);
    const account = tx.object(context.accountId);
    for (const id of agentIds) {
        tx.moveCall({
            target: `${context.chain.packageId}::memory::rollback_agent_owner_rotation_reference`,
            arguments: [account, tx.object(objectId(id, "agent object ID")), tx.object(context.chain.clockId ?? CLOCK)],
        });
    }
    for (const id of organizationIds) {
        tx.moveCall({
            target: `${context.chain.packageId}::memory::rollback_organization_owner_rotation_reference`,
            arguments: [account, tx.object(objectId(id, "organization object ID")), tx.object(context.chain.clockId ?? CLOCK)],
        });
    }
    return tx;
}

export async function prepareOwnerRotationTransaction(
    client: MySoJsonRpcClient,
    transaction: Transaction,
    sender: string,
): Promise<Uint8Array> {
    const page = await client.getCoins({ owner: sender, coinType: MYSO, limit: 50 });
    const coin = page.data
        .filter((item) => BigInt(item.balance) >= 50_000_000n)
        .sort((a, b) => BigInt(a.balance) > BigInt(b.balance) ? -1 : BigInt(a.balance) < BigInt(b.balance) ? 1 : 0)[0];
    if (!coin) throw new Error("The signing wallet needs a MYSO coin with at least 50 MYSO for gas");
    transaction.setGasPayment([{ objectId: coin.coinObjectId, version: coin.version, digest: coin.digest }]);
    transaction.setGasBudget(50_000_000);
    return transaction.build({ client });
}

function canonicalAddress(value: string): string {
    return `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

/** Reads the pending migration record from its typed dynamic field, independent of browser storage. */
export async function loadPendingOwnerRotation(
    client: MySoJsonRpcClient,
    chain: OwnerRotationChainConfig,
    accountId: string,
    signal?: AbortSignal,
): Promise<PendingOwnerRotation | null> {
    const rotation = await getPendingOwnerRotationFields(client, chain, accountId, signal);
    if (!rotation) return null;
    const tableCount = (name: string) => readRotationTableSize(rotation, name);
    const oldOwner = rotation.old_owner;
    const newOwner = rotation.new_owner;
    const proposedAtMs = rotation.proposed_at_ms;
    if (typeof oldOwner !== "string" || typeof newOwner !== "string"
        || (typeof proposedAtMs !== "string" && typeof proposedAtMs !== "number" && typeof proposedAtMs !== "bigint")
        || !/^0x[0-9a-fA-F]{1,64}$/.test(oldOwner) || !/^0x[0-9a-fA-F]{1,64}$/.test(newOwner)
        || canonicalAddress(oldOwner) === canonicalAddress(newOwner)) {
        throw new Error("The owner migration record has invalid wallet addresses or proposal time");
    }
    const time = String(proposedAtMs);
    if (!/^(0|[1-9][0-9]*)$/.test(time)) throw new Error("The owner migration proposal time is invalid");
    return {
        accountId: canonicalAddress(accountId),
        oldOwner: canonicalAddress(oldOwner),
        newOwner: canonicalAddress(newOwner),
        agentCount: tableCount("agent_manifest"),
        organizationCount: tableCount("organization_manifest"),
        proposedAtMs: time,
    };
}

async function getPendingOwnerRotationFields(
    client: MySoJsonRpcClient,
    chain: OwnerRotationChainConfig,
    accountId: string,
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    const keyType = `${chain.packageId}::memory::MemoryOwnerRotationKey`;
    const valueType = `${chain.packageId}::memory::MemoryOwnerRotation`;
    const result = await client.getDynamicFieldObject({
        parentId: objectId(accountId, "memory account ID"),
        name: { type: keyType, value: {} },
        signal,
    });
    if (result.error?.code === "dynamicFieldNotFound") return null;
    const data = result.data;
    if (!data) {
        if (result.error) throw new Error("The owner migration record could not be read from the configured fullnode");
        return null;
    }
    const content = data.content;
    const expectedFieldType = `0x2::dynamic_field::Field<${keyType},${valueType}>`;
    if (content?.dataType !== "moveObject" || !content.type
        || content.type.replace(/\s/g, "").toLowerCase() !== expectedFieldType.replace(/\s/g, "").toLowerCase()
        || !data.owner || typeof data.owner !== "object" || !("ObjectOwner" in data.owner)
        || canonicalAddress(String(data.owner.ObjectOwner)) !== canonicalAddress(accountId)) {
        throw new Error("The owner migration record failed its on-chain type and ownership checks");
    }
    const field = content.fields as Record<string, unknown> | undefined;
    const value = field?.value as Record<string, unknown> | undefined;
    const rotation = value?.fields as Record<string, unknown> | undefined;
    if (!rotation) throw new Error("The owner migration record has no typed value fields");
    return rotation;
}

function readRotationTableSize(rotation: Record<string, unknown>, name: string): string {
    const table = rotation[name] as Record<string, unknown> | undefined;
    const fields = table?.fields as Record<string, unknown> | undefined;
    const count = fields?.size;
    if (typeof count !== "string" && typeof count !== "number" && typeof count !== "bigint") throw new Error("The owner migration record has an invalid manifest count");
    const parsed = String(count);
    if (!/^(0|[1-9][0-9]*)$/.test(parsed)) throw new Error("The owner migration manifest count is invalid");
    return parsed;
}

function readRotationTableId(rotation: Record<string, unknown>, name: string): string {
    const table = rotation[name] as Record<string, unknown> | undefined;
    const fields = table?.fields as Record<string, unknown> | undefined;
    const id = fields?.id as Record<string, unknown> | undefined;
    const objectIdValue = id?.id;
    if (typeof objectIdValue !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(objectIdValue)) throw new Error("The owner migration record has an invalid table ID");
    return objectIdValue;
}

async function readIdTable(client: MySoJsonRpcClient, parentId: string, expectedCount: string, signal?: AbortSignal): Promise<string[]> {
    const expected = BigInt(expectedCount);
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await client.getDynamicFields({ parentId, cursor, limit: 50, signal });
        for (const row of page.data) {
            if (row.name.type.replace(/\s/g, "").toLowerCase() !== "0x2::object::id") throw new Error("An owner migration table contains a non-ID key");
            if (typeof row.name.value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(row.name.value)) throw new Error("An owner migration table contains an invalid ID");
            const id = canonicalAddress(row.name.value);
            if (seen.has(id)) throw new Error("An owner migration table contains a duplicate ID");
            seen.add(id); ids.push(row.name.value);
        }
        if (page.hasNextPage && (!page.nextCursor || page.nextCursor === cursor || page.data.length === 0)) throw new Error("The owner migration table returned an invalid page cursor");
        cursor = page.hasNextPage ? page.nextCursor ?? undefined : undefined;
    } while (cursor);
    if (BigInt(ids.length) !== expected) throw new Error("The owner migration table is incomplete or changed while it was read");
    return ids;
}

/** Reads proposal membership and already-updated references from the persistent chain tables. */
export async function loadOwnerRotationProgress(client: MySoJsonRpcClient, chain: OwnerRotationChainConfig, accountId: string, signal?: AbortSignal): Promise<OwnerRotationProgress> {
    const rotation = await getPendingOwnerRotationFields(client, chain, accountId, signal);
    if (!rotation) throw new Error("There is no pending owner migration on chain");
    const pending = await loadPendingOwnerRotation(client, chain, accountId, signal);
    if (!pending) throw new Error("The owner migration was finalized while progress was being read");
    if (typeof rotation.old_owner !== "string" || typeof rotation.new_owner !== "string"
        || typeof rotation.proposed_at_ms !== "string" && typeof rotation.proposed_at_ms !== "number"
        || canonicalAddress(rotation.old_owner) !== pending.oldOwner
        || canonicalAddress(rotation.new_owner) !== pending.newOwner
        || String(rotation.proposed_at_ms) !== pending.proposedAtMs) {
        throw new Error("The pending owner migration changed while its progress was being read");
    }
    const account = await client.getObject({ id: accountId, options: { showContent: true, showOwner: true }, signal });
    const accountData = account.data;
    const expectedAccountType = `${chain.packageId}::memory::MemoryAccount`;
    if (!accountData?.content || accountData.content.dataType !== "moveObject"
        || accountData.content.type?.replace(/\s/g, "").toLowerCase() !== expectedAccountType.replace(/\s/g, "").toLowerCase()) {
        throw new Error("The migration account failed its on-chain type check");
    }
    const fields = accountData.content.fields as Record<string, unknown>;
    const accountOwner = fields.owner;
    const profileId = fields.profile_id;
    if (typeof accountOwner !== "string" || canonicalAddress(accountOwner) !== pending.oldOwner
        || typeof profileId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(profileId)) {
        throw new Error("The account owner or linked profile changed during migration");
    }
    const readTable = async (name: string) => readIdTable(client, readRotationTableId(rotation, name), readRotationTableSize(rotation, name), signal);
    const [agentObjectIds, organizationObjectIds, updatedAgentObjectIds, updatedOrganizationObjectIds] = await Promise.all([
        readTable("agent_manifest"), readTable("organization_manifest"), readTable("updated_agents"), readTable("updated_organizations"),
    ]);
    const agentSet = new Set(agentObjectIds.map(canonicalAddress));
    const organizationSet = new Set(organizationObjectIds.map(canonicalAddress));
    if (BigInt(agentObjectIds.length) !== BigInt(pending.agentCount)
        || BigInt(organizationObjectIds.length) !== BigInt(pending.organizationCount)
        || updatedAgentObjectIds.some((id) => !agentSet.has(canonicalAddress(id)))
        || updatedOrganizationObjectIds.some((id) => !organizationSet.has(canonicalAddress(id)))) {
        throw new Error("The pending migration progress does not match its immutable manifest");
    }
    return { ...pending, profileId: canonicalAddress(profileId), agentObjectIds, organizationObjectIds, updatedAgentObjectIds, updatedOrganizationObjectIds };
}

async function readCompleteKind(
    kind: OwnerRotationKind,
    signal?: AbortSignal,
    onPage?: (kind: OwnerRotationKind, pagesRead: number, objectCount: number) => void,
): Promise<OwnerRotationPage> {
    let cursor: string | undefined;
    let pagesRead = 0;
    let identity: Pick<OwnerRotationPage, "accountId" | "owner" | "profileId" | "tableCount"> | undefined;
    const items: string[] = [];
    const seen = new Set<string>();

    do {
        const query = new URLSearchParams({ kind, limit: "50" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api/myso/owner-rotation/manifest?${query}`, {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            signal,
            headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
            const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
                ? body.error
                : `Owner migration ${kind} references could not be loaded`;
            throw new Error(message);
        }
        const page = body as OwnerRotationPage;
        if (page.kind !== kind || page.evidenceSource !== "configured_fullnode"
            || !Array.isArray(page.items) || page.items.length > 50
            || page.hasNextPage !== (page.nextCursor !== null)
            || (page.hasNextPage && (!page.items.length || page.nextCursor === cursor))) {
            throw new Error(`The ${kind} reference page failed validation`);
        }
        const nextIdentity = {
            accountId: canonicalAddress(page.accountId),
            owner: canonicalAddress(page.owner),
            profileId: canonicalAddress(page.profileId),
            tableCount: page.tableCount,
        };
        if (!/^(0|[1-9][0-9]*)$/.test(nextIdentity.tableCount)) {
            throw new Error(`The ${kind} table count is invalid`);
        }
        if (identity && (identity.accountId !== nextIdentity.accountId
            || identity.owner !== nextIdentity.owner
            || identity.profileId !== nextIdentity.profileId
            || identity.tableCount !== nextIdentity.tableCount)) {
            throw new Error(`The ${kind} registry changed while its manifest was being read; refresh and retry`);
        }
        identity ??= nextIdentity;
        for (const objectId of page.items) {
            const key = canonicalAddress(objectId);
            if (seen.has(key)) throw new Error(`The ${kind} manifest contains a duplicate object`);
            seen.add(key);
            items.push(objectId);
        }
        pagesRead += 1;
        onPage?.(kind, pagesRead, items.length);
        cursor = page.hasNextPage ? page.nextCursor ?? undefined : undefined;
        if (page.hasNextPage && !cursor) throw new Error(`The ${kind} manifest is missing its next cursor`);
    } while (cursor);

    if (!identity) throw new Error(`The ${kind} manifest response was empty`);
    if (BigInt(identity.tableCount) !== BigInt(items.length)) {
        throw new Error(`The ${kind} manifest is incomplete: expected ${identity.tableCount}, received ${items.length}`);
    }
    return { kind, ...identity, items, hasNextPage: false, nextCursor: null, evidenceSource: "configured_fullnode" };
}

/** Reads every owner-linked shared object and rejects mixed snapshots, duplicates, or partial pages. */
export async function loadCompleteOwnerRotationManifest(
    signal?: AbortSignal,
    onPage?: (kind: OwnerRotationKind, pagesRead: number, objectCount: number) => void,
): Promise<CompleteOwnerRotationManifest> {
    const [agents, organizations] = await Promise.all([
        readCompleteKind("agents", signal, onPage),
        readCompleteKind("organizations", signal, onPage),
    ]);
    if (canonicalAddress(agents.accountId) !== canonicalAddress(organizations.accountId)
        || canonicalAddress(agents.owner) !== canonicalAddress(organizations.owner)
        || canonicalAddress(agents.profileId) !== canonicalAddress(organizations.profileId)) {
        throw new Error("Agent and organization manifests do not belong to the same account snapshot");
    }
    return {
        accountId: agents.accountId,
        owner: agents.owner,
        profileId: agents.profileId,
        agentObjectIds: agents.items,
        organizationObjectIds: organizations.items,
        agentCount: agents.tableCount,
        organizationCount: organizations.tableCount,
        evidenceSource: "configured_fullnode",
    };
}
