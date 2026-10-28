"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, RefreshCw } from "lucide-react";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { useCurrentAccount, useSignPersonalMessage } from "@socialproof/dapp-kit";
import { AgentMyDataReaderPolicy, createAgentMessagingClient, createMySoMessagingStackClient, resolveGenesisMessagingConfig, waitForMembership, type MySoMessagingStackClient } from "@socialproof/myso-messaging-stack";
import { CustodyVault, PRIMARY_CUSTODY } from "@/src/agent/custody-vault";
import { deriveMySocialLoginSeed } from "@/src/agent/custody-session";
import { R2RoomAttachmentStorage } from "@/src/agent/r2-room-attachment-storage";
import { mySoTaskScopeSchema, type ExecutionScope } from "@/src/core";

type Context = { scope: ExecutionScope; derivedAddress: string; rpcUrl: string; socialChain: { packageId: string; memoryConfigId: string; platformObjectId: string; [key: string]: unknown } };
type Seller = { sellerAccountId: string; agentObjectId: string; principal: string; label: string; reviewCount: number; score: number; settledCount: number };
type FundingCoin = { coinObjectId: string; coinType: string; balanceBaseUnits: string; version: string };
type FundingPage = { data: FundingCoin[]; hasNextPage: boolean; nextCursor: string | null; maxActionSpendMist: string | null; notice: string };
type OfferReceipt = { digest: string; taskId: string | null; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };
type RoomBindingReceipt = { digest: string; taskId: string; groupId: string; status: "finalized" | "checkpoint_pending" | "failed" | "unknown"; verification: string };
type PreparedRoom = { groupId: string; uuid: string; sellerAgentId: string; digestHex: string; scopeMessage: string };
type PendingRoomAttempt = { version: 1; uuid: string; groupId?: string; creationDigest?: string };
type SubmittedOffer = { digest: string; sellerLabel: string; groupId: string; receipt?: OfferReceipt; bindingDigest?: string; bindingReceipt?: RoomBindingReceipt; taskId?: string };

const NETWORKS = new Set(["mainnet", "testnet", "devnet", "localnet"]);
const normalizeAddress = (value: string) => `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
const sameAddress = (left: string, right: string) => normalizeAddress(left) === normalizeAddress(right);
const idPattern = /^0x[0-9a-fA-F]{1,64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readPendingRoomAttempt(key: string): PendingRoomAttempt | null {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        const value = parsed as Record<string, unknown>;
        if (value.version !== 1 || typeof value.uuid !== "string" || !uuidPattern.test(value.uuid) || value.groupId !== undefined && (typeof value.groupId !== "string" || !idPattern.test(value.groupId)) || value.creationDigest !== undefined && (typeof value.creationDigest !== "string" || value.creationDigest.length < 1 || value.creationDigest.length > 128)) return null;
        return { version: 1, uuid: value.uuid, ...(typeof value.groupId === "string" ? { groupId: value.groupId } : {}), ...(typeof value.creationDigest === "string" ? { creationDigest: value.creationDigest } : {}) };
    } catch { return null; }
}

function writePendingRoomAttempt(key: string, attempt: PendingRoomAttempt) {
    sessionStorage.setItem(key, JSON.stringify(attempt));
}

function eventField(event: Record<string, unknown>, snake: string, camel: string): unknown {
    const parsed = event.parsedJson;
    if (!parsed || typeof parsed !== "object") return undefined;
    const fields = parsed as Record<string, unknown>;
    return fields[snake] ?? fields[camel];
}

function optionId(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const raw = record.vec ?? (record.fields && typeof record.fields === "object" ? (record.fields as Record<string, unknown>).vec : undefined);
    if (Array.isArray(raw) && raw.length <= 1) return typeof raw[0] === "string" ? raw[0] : null;
    return null;
}

function roomAttemptStorageKey(scope: ExecutionScope, sellerAgentId: string, digestHex: string) {
    return `myso-agents:task-room-attempt:${scope.network}:${normalizeAddress(scope.accountId)}:${normalizeAddress(scope.agentId)}:${normalizeAddress(sellerAgentId)}:${digestHex.toLowerCase()}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/myso/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "This request could not finish");
    return data as T;
}

function decimalU64(value: string, label: string): bigint {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a whole number.`);
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > 18446744073709551615n) throw new Error(`${label} is outside the supported range.`);
    return parsed;
}

async function verifiedSellerAddress(client: MySoJsonRpcClient, packageId: string, seller: Seller): Promise<string> {
    const result = await client.getObject({ id: seller.agentObjectId, options: { showContent: true } });
    const content = result.data?.content;
    if (!content || content.dataType !== "moveObject") throw new Error("The selected seller agent could not be verified on chain.");
    const [pkg, module, type] = content.type.split("::");
    const fields = content.fields as Record<string, unknown>;
    if (normalizeAddress(pkg ?? "") !== normalizeAddress(packageId) || module !== "memory" || type !== "SubAgent" || fields.active !== true || !sameAddress(String(fields.memory_account_id), seller.sellerAccountId) || !sameAddress(String(fields.principal_owner), seller.principal) || typeof fields.derived_address !== "string" || !idPattern.test(fields.derived_address)) throw new Error("The indexed seller listing does not match its active on-chain agent identity.");
    const expiry = fields.expires_at as unknown;
    const expiryValue = expiry && typeof expiry === "object" && "vec" in expiry ? (expiry as { vec?: unknown }).vec : expiry;
    if (Array.isArray(expiryValue) && expiryValue.length && Number(expiryValue[0]) < Date.now()) throw new Error("The selected seller agent is expired.");
    return fields.derived_address;
}

export function MySoTaskOfferComposer({ context, sellers, tools }: { context: Context; sellers: Seller[]; tools: Array<{ name: string }> }) {
    const wallet = useCurrentAccount();
    const personal = useSignPersonalMessage();
    const [expanded, setExpanded] = useState(false);
    const [sellerAgentId, setSellerAgentId] = useState("");
    const [title, setTitle] = useState("");
    const [scope, setScope] = useState("");
    const [acceptance, setAcceptance] = useState("");
    const [amountMist, setAmountMist] = useState("");
    const [acceptMinutes, setAcceptMinutes] = useState("");
    const [deliveryMinutes, setDeliveryMinutes] = useState("");
    const [settleMinutes, setSettleMinutes] = useState("");
    const [coins, setCoins] = useState<FundingCoin[]>([]);
    const [coinId, setCoinId] = useState("");
    const [coinCursor, setCoinCursor] = useState<string | null>(null);
    const [coinHasNext, setCoinHasNext] = useState(false);
    const [maxSpendMist, setMaxSpendMist] = useState<string | null>(null);
    const [coinLoading, setCoinLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [preparedRoom, setPreparedRoom] = useState<PreparedRoom | null>(null);
    const [submitted, setSubmitted] = useState<SubmittedOffer | null>(null);
    const [statusMessage, setStatusMessage] = useState("");
    const [custodyReady, setCustodyReady] = useState(false);
    const [unlocking, setUnlocking] = useState(false);
    const [custodyError, setCustodyError] = useState("");
    const [scopeWasSent, setScopeWasSent] = useState(false);

    const network = NETWORKS.has(context.scope.network) ? context.scope.network as "mainnet" | "testnet" | "devnet" | "localnet" : null;
    const client = useMemo(() => network ? new MySoJsonRpcClient({ url: context.rpcUrl, network }) : null, [network, context.rpcUrl]);
    const memoryUrl = process.env.NEXT_PUBLIC_MYSO_MEMORY_URL;
    const relayerUrl = process.env.NEXT_PUBLIC_MYSO_MESSAGING_RELAYER_URL;
    const platformId = context.scope.platformId ?? context.socialChain.platformObjectId;
    const configError = !network || !client || !memoryUrl || !relayerUrl || !platformId || !context.socialChain.memoryConfigId || !context.socialChain.packageId;
    const vault = useMemo(() => {
        if (!memoryUrl || !client) return null;
        const instance = new CustodyVault(memoryUrl, { accountId: context.scope.accountId, owner: context.scope.owner }, async (message) => {
            if (!wallet || !sameAddress(wallet.address, context.scope.owner)) throw new Error("Connect the owner wallet to unlock local agent custody.");
            return (await personal.mutateAsync({ message, chain: `myso:${context.scope.network}` })).signature;
        }, async (agentId, envelope) => {
            const result = await client.getObject({ id: agentId, options: { showContent: true } });
            const content = result.data?.content;
            if (!content || content.dataType !== "moveObject") throw new Error("The agent custody identity could not be verified on chain.");
            const [pkg, module, type] = content.type.split("::");
            const fields = content.fields as Record<string, unknown>;
            const publicKey = Array.isArray(fields.public_key) ? fields.public_key.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("") : "";
            if (!sameAddress(pkg ?? "", envelope.packageId) || module !== "memory" || type !== "SubAgent" || publicKey !== envelope.publicKey || fields.active !== true || !sameAddress(String(fields.memory_account_id), context.scope.accountId) || !sameAddress(String(fields.principal_owner), context.scope.owner) || !sameAddress(String(fields.derived_address), envelope.derivedAddress) || !sameAddress(agentId, context.scope.agentId)) throw new Error("The custody key does not match this active MySo agent.");
        });
        instance.setLoginSeedProvider(deriveMySocialLoginSeed);
        return instance;
    }, [memoryUrl, client, context.scope.accountId, context.scope.owner, context.scope.network, context.scope.agentId, wallet, personal.mutateAsync]);

    const getAgentClient = useCallback(async () => {
        if (!client || !vault || !relayerUrl || !platformId) throw new Error("Encrypted room messaging is not configured for this network.");
        if (!custodyReady) throw new Error("Unlock agent custody before creating the encrypted task room.");
        const agent = await vault.getAgent({ agent_object_id: context.scope.agentId, derived_address: context.derivedAddress, organization_id: context.scope.organizationId ?? null });
        const packageConfig = await resolveGenesisMessagingConfig(client, { rpcUrl: context.rpcUrl, graphqlUrl: process.env.NEXT_PUBLIC_GRAPHQL_URL });
        const messagingClient = createMySoMessagingStackClient(client, {
            mydata: { serverConfigs: [], verifyKeyServers: false },
            encryption: { sessionKey: { signer: agent.keypair }, mydataPolicy: new AgentMyDataReaderPolicy({ originalPackageId: packageConfig.messaging.originalPackageId, latestPackageId: packageConfig.messaging.latestPackageId, versionId: packageConfig.messaging.versionId, platformId, memoryConfigId: packageConfig.messaging.memoryConfigId, memoryAccountId: context.scope.accountId, agentDerivedAddress: context.derivedAddress }) },
            packageConfig,
            relayer: { relayerUrl },
            attachments: { storageAdapter: new R2RoomAttachmentStorage(), maxAttachments: 10, maxFileSizeBytes: 5 * 1024 * 1024, maxTotalFileSizeBytes: 50 * 1024 * 1024 },
        });
        const agentClient = createAgentMessagingClient({ messaging: messagingClient.messaging, agent: { agentSigner: agent.keypair, subAgentId: context.scope.agentId, principalOwner: context.scope.owner, identityClass: 0, memoryAccountId: context.scope.accountId, platformId } });
        return { agentClient, messagingClient, agent };
    }, [client, vault, relayerUrl, platformId, custodyReady, context.scope.agentId, context.derivedAddress, context.scope.organizationId, context.rpcUrl, context.scope.accountId, context.scope.owner]);

    async function verifyCreatedRoom(uuid: string, groupId: string, expectedDigest?: string): Promise<string | null> {
        if (!client) return null;
        try {
            const object = await client.getObject({ id: groupId, options: { showContent: true } });
            const content = object.data?.content;
            if (!content || content.dataType !== "moveObject") return null;
            const objectFields = content.fields as Record<string, unknown>;
            const objectType = content.type;
            const objectCreator = typeof objectFields?.creator === "string" ? objectFields.creator : "";
            const previousTransaction = (object.data as { previousTransaction?: unknown } | undefined)?.previousTransaction;
            if (!objectType.includes("::PermissionedGroup<") || !sameAddress(objectCreator, context.derivedAddress) || expectedDigest === undefined && typeof previousTransaction !== "string") return null;
            const digest = expectedDigest ?? previousTransaction;
            if (typeof digest !== "string") return null;
            const receipt = await client.getTransactionBlock({ digest, options: { showEffects: true, showEvents: true } });
            if (receipt.effects?.status?.status !== "success") return null;
            const matches = (receipt.events ?? []).filter((candidate) => {
                const event = candidate as unknown as Record<string, unknown>;
                if (typeof event.type !== "string" || !event.type.endsWith("::messaging::AgentGroupCreated")) return false;
                const eventGroup = eventField(event, "group_id", "groupId");
                const eventUuid = eventField(event, "group_uuid", "groupUuid");
                const actor = eventField(event, "creator_actor", "creatorActor");
                const principal = eventField(event, "creator_principal", "creatorPrincipal");
                const subAgent = optionId(eventField(event, "creator_sub_agent_id", "creatorSubAgentId"));
                return typeof eventGroup === "string" && sameAddress(eventGroup, groupId)
                    && eventUuid === uuid && typeof actor === "string" && sameAddress(actor, context.derivedAddress)
                    && typeof principal === "string" && sameAddress(principal, context.scope.owner)
                    && !!subAgent && sameAddress(subAgent, context.scope.agentId);
            });
            return matches.length === 1 ? digest : null;
        } catch { return null; }
    }

    useEffect(() => () => { vault?.lock(); }, [vault]);

    async function loadCoins(cursor?: string, append = false) {
        setCoinLoading(true); setError("");
        try {
            const query = new URLSearchParams({ limit: "50" }); if (cursor) query.set("cursor", cursor);
            const page = await api<FundingPage>(`task-market/funding-coins?${query}`);
            setCoins(previous => append ? [...previous, ...page.data] : page.data);
            setCoinCursor(page.nextCursor); setCoinHasNext(page.hasNextPage); setMaxSpendMist(page.maxActionSpendMist);
            setCoinId(current => current || page.data.find(coin => BigInt(coin.balanceBaseUnits) >= (amountMist && /^\d+$/.test(amountMist) ? BigInt(amountMist) : 0n))?.coinObjectId || page.data[0]?.coinObjectId || "");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent MYSO coins are unavailable."); }
        finally { setCoinLoading(false); }
    }

    useEffect(() => { if (expanded && tools.some(tool => tool.name === "task_list_agent_funding_coins") && coins.length === 0 && !coinLoading) void loadCoins(); }, [expanded, tools, coins.length, coinLoading]);

    async function unlockCustody() {
        if (!vault || configError) return;
        setUnlocking(true); setCustodyError("");
        try { await vault.unlock({ method: PRIMARY_CUSTODY }); setCustodyReady(true); }
        catch (reason) { setCustodyError(reason instanceof Error ? reason.message : "Agent custody could not be unlocked."); }
        finally { setUnlocking(false); }
    }

    async function createOffer(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); setSubmitting(true); setError(""); setStatusMessage("");
        try {
            if (!tools.some(tool => tool.name === "task_create") || !tools.some(tool => tool.name === "task_list_agent_funding_coins")) throw new Error("Task offer actions are unavailable to this agent.");
            if (!sellerAgentId) throw new Error("Choose a seller agent.");
            if (!custodyReady) throw new Error("Unlock agent custody before sending the private scope.");
            const seller = sellers.find(item => item.agentObjectId === sellerAgentId); if (!seller) throw new Error("The selected seller is no longer in the loaded directory.");
            const selectedCoin = coins.find(coin => coin.coinObjectId === coinId); if (!selectedCoin) throw new Error("Choose one of this agent’s MYSO funding coins.");
            const amount = decimalU64(amountMist, "Escrow amount");
            if (BigInt(selectedCoin.balanceBaseUnits) < amount) throw new Error("The selected agent coin does not cover the escrow amount.");
            const acceptedLimit = maxSpendMist === null ? null : BigInt(maxSpendMist);
            if (acceptedLimit === null || amount > acceptedLimit) throw new Error("The agent’s live per-action spend limit is unavailable or below this amount. No wallet fallback is offered for this agent-funded action.");
            const taskTitle = title.trim(); const privateScope = scope.trim(); const doneWhen = acceptance.trim();
            if (!taskTitle || !privateScope || !doneWhen) throw new Error("Add a title, private work scope, and completion criteria.");
            if (new TextEncoder().encode(taskTitle).byteLength > 256) throw new Error("The task title is longer than the on-chain 256-byte limit.");
            const acceptWindowMs = decimalU64(acceptMinutes, "Acceptance window") * 60_000n;
            const deliveryWindowMs = decimalU64(deliveryMinutes, "Delivery window") * 60_000n;
            const settleWindowMs = decimalU64(settleMinutes, "Settlement window") * 60_000n;
            for (const [label, value] of [["Acceptance window", acceptWindowMs], ["Delivery window", deliveryWindowMs], ["Settlement window", settleWindowMs]] as const) if (value > 18446744073709551615n) throw new Error(`${label} is outside the supported range.`);
            const envelope = mySoTaskScopeSchema.parse({ type: "myso.task.scope.v1", version: 1, title: taskTitle, scope: privateScope, acceptanceCriteria: doneWhen });
            const scopeMessage = JSON.stringify(envelope);
            const digestHex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scopeMessage))), byte => byte.toString(16).padStart(2, "0")).join("");
            const sellerAddress = await verifiedSellerAddress(client!, context.socialChain.packageId, seller);
            const attemptKey = roomAttemptStorageKey(context.scope, seller.agentObjectId, digestHex);
            let attempt = readPendingRoomAttempt(attemptKey);
            if (!attempt) {
                attempt = { version: 1, uuid: crypto.randomUUID() };
                writePendingRoomAttempt(attemptKey, attempt);
            }
            const { agentClient, messagingClient } = await getAgentClient();
            const deterministicGroupId = messagingClient.messaging.derive.groupId({ uuid: attempt.uuid });
            let room = preparedRoom && preparedRoom.sellerAgentId === seller.agentObjectId && preparedRoom.digestHex === digestHex ? preparedRoom : null;
            if (!room) {
                let created: { groupId: string; uuid: string; digest?: string };
                const recoveredDigest = attempt.groupId ? await verifyCreatedRoom(attempt.uuid, attempt.groupId, attempt.creationDigest) : null;
                if (attempt.groupId && recoveredDigest) {
                    created = { groupId: attempt.groupId, uuid: attempt.uuid, digest: recoveredDigest };
                } else {
                    try {
                        created = await agentClient.createAgentGroupAndWait({
                            uuid: attempt.uuid, name: `Task: ${taskTitle.slice(0, 80)}`, initialMembers: [sellerAddress],
                            platformId, creatorMemoryAccountId: context.scope.accountId,
                            crossPrincipalPeerMemoryAccountId: seller.sellerAccountId,
                            room: { kind: 1 },
                            waitForAgentSender: true, waitForPrincipalReader: false,
                        });
                        if (!sameAddress(created.groupId, deterministicGroupId) || !await verifyCreatedRoom(created.uuid, created.groupId, created.digest)) throw new Error("The newly created task room is missing its exact finalized creator event.");
                    } catch (createError) {
                        const verifiedDigest = await verifyCreatedRoom(attempt.uuid, deterministicGroupId);
                        if (!verifiedDigest) throw createError;
                        await waitForMembership({ messaging: messagingClient as unknown as MySoMessagingStackClient<unknown>, groupId: deterministicGroupId, memberAddress: context.derivedAddress, permission: "MessagingSender", timeoutMs: 30_000 });
                        created = { groupId: deterministicGroupId, uuid: attempt.uuid, digest: verifiedDigest };
                    }
                }
                if (!sameAddress(created.groupId, deterministicGroupId) || created.uuid !== attempt.uuid) throw new Error("Recovered task room identity did not match the saved creation attempt.");
                attempt = { version: 1, uuid: attempt.uuid, groupId: created.groupId, ...(created.digest ? { creationDigest: created.digest } : {}) };
                writePendingRoomAttempt(attemptKey, attempt);
                room = { groupId: created.groupId, uuid: created.uuid, sellerAgentId: seller.agentObjectId, digestHex, scopeMessage };
                setPreparedRoom(room);
            }
            await waitForMembership({ messaging: messagingClient as unknown as MySoMessagingStackClient<unknown>, groupId: room.groupId, memberAddress: context.derivedAddress, permission: "MessagingSender", timeoutMs: 30_000 });
            const history = await agentClient.getMessages({ groupRef: { uuid: room.uuid }, limit: 50 });
            const ownScopeMessages = history.messages.filter(message => !message.isDeleted && message.text === scopeMessage && sameAddress(message.senderAddress, context.derivedAddress));
            if (ownScopeMessages.some(message => !message.senderVerified)) throw new Error("The existing task-room scope message could not be signature-verified; no duplicate was sent.");
            const scopeAlreadySent = ownScopeMessages.some(message => message.senderVerified);
            if (!scopeAlreadySent && history.hasNext) throw new Error("The task-room history is incomplete, so the app cannot safely determine whether the scope was already sent.");
            if (!scopeAlreadySent) {
                await waitForMembership({ messaging: messagingClient as unknown as MySoMessagingStackClient<unknown>, groupId: room.groupId, memberAddress: sellerAddress, permission: "MessagingReader", timeoutMs: 30_000 });
                await agentClient.sendMessage({ groupRef: { uuid: room.uuid }, text: scopeMessage });
            }
            setScopeWasSent(true);
            const operationIdentity = JSON.stringify({ digestHex, sellerAgentId: seller.agentObjectId, amountMist: amount.toString(), acceptWindowMs: acceptWindowMs.toString(), deliveryWindowMs: deliveryWindowMs.toString(), settleWindowMs: settleWindowMs.toString(), paymentCoinId: selectedCoin.coinObjectId });
            const operationSuffix = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationIdentity))), byte => byte.toString(16).padStart(2, "0")).join("");
            const operationStorageKey = `myso-agents:task-offer:${operationSuffix}`;
            const operationKey = sessionStorage.getItem(operationStorageKey) ?? crypto.randomUUID();
            sessionStorage.setItem(operationStorageKey, operationKey);
            const result = await api<{ submitted: true; transactionDigest: string }>("tasks/offers", { method: "POST", body: JSON.stringify({
                sellerAccountId: seller.sellerAccountId, sellerAgentId: seller.agentObjectId, amountMist: amount.toString(), scopeDigestHex: digestHex,
                title: taskTitle, acceptWindowMs: acceptWindowMs.toString(), deliveryWindowMs: deliveryWindowMs.toString(), settleWindowMs: settleWindowMs.toString(),
                paymentCoinId: selectedCoin.coinObjectId, roomGroupId: room.groupId, platformId, idempotencyKey: operationKey,
            }) });
            setSubmitted({ digest: result.transactionDigest, sellerLabel: seller.label || "MySocial agent", groupId: room.groupId });
            setStatusMessage("The offer transaction was submitted. Verify its finalized event before treating the escrow as offered.");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The task offer could not be created."); }
        finally { setSubmitting(false); }
    }

    async function verifyOffer() {
        if (!submitted) return;
        setSubmitting(true); setError("");
        try {
            const receipt = await api<OfferReceipt>(`tasks/offers/${encodeURIComponent(submitted.digest)}/receipt`);
            setSubmitted(current => current ? { ...current, receipt } : current);
            if (receipt.status === "finalized" && receipt.taskId) setStatusMessage("The exact TaskOffered event is finalized. Link the private room to finish setup.");
            else setStatusMessage(`Offer receipt status: ${receipt.status.replaceAll("_", " ")}. The event is not yet finalized.`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The offer receipt could not be verified."); }
        finally { setSubmitting(false); }
    }

    async function bindRoom() {
        if (!submitted?.receipt?.taskId) return;
        setSubmitting(true); setError("");
        try {
            const keyName = `myso-agents:task-room-bind:${submitted.receipt.taskId}`;
            const idempotencyKey = sessionStorage.getItem(keyName) ?? crypto.randomUUID(); sessionStorage.setItem(keyName, idempotencyKey);
            const result = await api<{ transactionDigest: string }>(`tasks/${encodeURIComponent(submitted.receipt.taskId)}/bind-room`, { method: "POST", body: JSON.stringify({ idempotencyKey }) });
            setSubmitted(current => current ? { ...current, taskId: submitted.receipt!.taskId!, bindingDigest: result.transactionDigest } : current);
            setStatusMessage("The room-to-task binding was submitted. Checking its finalized event now.");
            const query=new URLSearchParams({taskId:submitted.receipt.taskId,groupId:submitted.groupId});
            const receipt=await api<RoomBindingReceipt>(`tasks/room-binding-receipts/${encodeURIComponent(result.transactionDigest)}?${query}`);
            setSubmitted(current=>current?{...current,bindingReceipt:receipt}:current);
            setStatusMessage(receipt.status==="finalized"?"The finalized AgentRoomTaskBound event confirms this encrypted room is linked to the task.":`Room binding receipt status: ${receipt.status.replaceAll("_"," ")}.`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The room binding is pending; retry after the task is indexed."); }
        finally { setSubmitting(false); }
    }

    function close() {
        setExpanded(false); setError(""); setCustodyError(""); setStatusMessage(""); setCustodyReady(false); vault?.lock();
        if (!scopeWasSent || submitted) { setSubmitted(null); setPreparedRoom(null); setScopeWasSent(false); }
    }

    return <section className="myso-settlement-receipt" aria-label="Create a funded task offer">
        <div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">CREATE A TASK</p><h2>Fund work for a named seller</h2></div><button type="button" className="myso-secondary" onClick={() => setExpanded(value => !value)}>{expanded ? "Close offer form" : "Create task offer"}<ArrowRight size={16}/></button></div>
        {!expanded && <p>Choose an active seller, set the escrow and deadlines, and send the private scope through a newly created encrypted agent room. Funding comes from this agent’s MYSO coins and the live on-chain per-action cap.</p>}
        {expanded && <form className="myso-create" onSubmit={createOffer}>
            {configError && <p className="myso-knowledge-note" role="alert">This network is missing the messaging, custody, or MySo RPC configuration needed to create a private task room.</p>}
            {custodyReady ? <p className="myso-knowledge-note"><LockKeyhole size={15}/> Agent custody unlocked locally for encrypted room creation.</p> : <button type="button" className="myso-secondary" disabled={configError || unlocking} onClick={() => void unlockCustody()}>{unlocking ? "Unlocking agent custody…" : "Unlock agent custody to create room"}</button>}
            {custodyError && <p className="myso-knowledge-note" role="alert">{custodyError}</p>}
            <label htmlFor="task-offer-seller">Seller agent</label><select id="task-offer-seller" required value={sellerAgentId} disabled={submitting||scopeWasSent} onChange={event => { setSellerAgentId(event.target.value); setPreparedRoom(null); }}><option value="">Choose an active seller</option>{sellers.map(seller => <option key={seller.agentObjectId} value={seller.agentObjectId}>{seller.label || "MySocial agent"} · {seller.reviewCount ? `${seller.score.toFixed(1)} / 5` : "No reviews"} · {seller.settledCount} settled</option>)}</select>
            <label htmlFor="task-offer-title">Task title</label><input id="task-offer-title" required maxLength={256} value={title} onChange={event => { setTitle(event.target.value); setPreparedRoom(null); }} disabled={submitting||scopeWasSent}/>
            <label htmlFor="task-offer-scope">Private work scope</label><textarea id="task-offer-scope" required rows={5} maxLength={12000} value={scope} onChange={event => { setScope(event.target.value); setPreparedRoom(null); }} disabled={submitting||scopeWasSent}/>
            <label htmlFor="task-offer-acceptance">Completion criteria</label><textarea id="task-offer-acceptance" required rows={3} maxLength={4000} value={acceptance} onChange={event => { setAcceptance(event.target.value); setPreparedRoom(null); }} disabled={submitting||scopeWasSent}/>
            <p className="myso-knowledge-note">Only the selected seller’s verified agent address is invited to a new encrypted room. The room message includes the private scope and criteria; its SHA-256 digest is committed to the on-chain offer. The scope is sent before escrow submission so the seller has the instructions before accepting.</p>
            <label htmlFor="task-offer-amount">Escrow amount in MIST</label><input id="task-offer-amount" required inputMode="numeric" pattern="[1-9][0-9]*" value={amountMist} onChange={event => { setAmountMist(event.target.value); setCoinId(""); }} disabled={submitting}/>
            <label htmlFor="task-offer-coin">Agent-owned MYSO coin</label><select id="task-offer-coin" required value={coinId} disabled={submitting || coinLoading} onChange={event => setCoinId(event.target.value)}><option value="">{coinLoading ? "Loading agent coins…" : "Choose an agent coin"}</option>{coins.map(coin => <option key={coin.coinObjectId} value={coin.coinObjectId}>{coin.balanceBaseUnits} MIST · {coin.coinObjectId}</option>)}</select>
            {maxSpendMist !== null && <p className="myso-knowledge-note">Live maximum per-action spend: {maxSpendMist} MIST. Move checks the cap again when the offer is submitted.</p>}
            <button type="button" className="myso-secondary" disabled={coinLoading||submitting} onClick={() => void loadCoins(coinCursor ?? undefined, coinHasNext)}><RefreshCw size={15}/>{coinLoading ? "Loading coins…" : coinHasNext ? "Load more agent coins" : "Refresh agent coins"}</button>
            <label htmlFor="task-offer-accept-minutes">Acceptance window (minutes)</label><input id="task-offer-accept-minutes" type="number" min="1" step="1" required value={acceptMinutes} onChange={event => setAcceptMinutes(event.target.value)} disabled={submitting}/>
            <label htmlFor="task-offer-delivery-minutes">Delivery window (minutes)</label><input id="task-offer-delivery-minutes" type="number" min="1" step="1" required value={deliveryMinutes} onChange={event => setDeliveryMinutes(event.target.value)} disabled={submitting}/>
            <label htmlFor="task-offer-settle-minutes">Settlement window (minutes)</label><input id="task-offer-settle-minutes" type="number" min="1" step="1" required value={settleMinutes} onChange={event => setSettleMinutes(event.target.value)} disabled={submitting}/>
            {scopeWasSent && !submitted && <p className="myso-knowledge-note">The private scope has already been delivered to this seller. Retrying will reuse the prepared room and not send a duplicate message.</p>}
            {error && <p className="myso-knowledge-note" role="alert">{error}</p>}
            <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={submitting} onClick={close}>Cancel</button><button type="submit" className="myso-primary" disabled={submitting || !custodyReady || configError || !tools.some(tool => tool.name === "task_create")}>{submitting ? "Preparing encrypted offer…" : "Send scope and create funded offer"}<ArrowRight size={16}/></button></div>
        </form>}
        {submitted && <div className="myso-verified-receipt" role="status"><strong>Offer transaction submitted to {submitted.sellerLabel}</strong><span>Transaction {submitted.digest}</span><span>Encrypted room {submitted.groupId}</span>{submitted.receipt?.status === "finalized" && submitted.receipt.taskId && <><span>Finalized task {submitted.receipt.taskId}</span><button type="button" className="myso-secondary" disabled={submitting||!!submitted.bindingReceipt||!!submitted.bindingDigest} onClick={() => void bindRoom()}>{submitted.bindingReceipt?.status==="finalized"?"Encrypted room linked to task":submitted.bindingDigest?`Room binding submitted · ${submitted.bindingDigest}`:submitting ? "Linking room…" : "Link encrypted room to task"}</button></>}{submitted.bindingDigest&&<button type="button" className="myso-secondary" disabled={submitting} onClick={async()=>{setSubmitting(true);setError("");try{const query=new URLSearchParams({taskId:submitted.taskId!,groupId:submitted.groupId});const receipt=await api<RoomBindingReceipt>(`tasks/room-binding-receipts/${encodeURIComponent(submitted.bindingDigest!)}?${query}`);setSubmitted(current=>current?{...current,bindingReceipt:receipt}:current);setStatusMessage(receipt.status==="finalized"?"The finalized AgentRoomTaskBound event confirms the room link.":`Room binding receipt status: ${receipt.status.replaceAll("_"," ")}.`);}catch(reason){setError(reason instanceof Error?reason.message:"Room binding receipt could not be verified.");}finally{setSubmitting(false);}}}>{submitting?"Checking room link…":submitted.bindingReceipt?.status==="finalized"?`Refresh room-link receipt · ${submitted.bindingReceipt.digest}`:"Verify room-link receipt"}</button>}{submitted.receipt?.status === "failed" && <span>The offer transaction failed. The encrypted scope remains in the selected seller’s room; the escrow was not offered.</span>}{statusMessage && <span>{statusMessage}</span>}<button type="button" className="myso-secondary" disabled={submitting} onClick={() => void verifyOffer()}>{submitting ? "Checking fullnode…" : submitted.receipt ? "Refresh offer receipt" : "Verify finalized offer receipt"}</button></div>}
    </section>;
}
