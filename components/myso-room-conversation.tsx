"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole, Paperclip, Send, UserPlus, Wallet } from "lucide-react";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { useConnectWallet, useCurrentAccount, useSignPersonalMessage, useWallets } from "@socialproof/dapp-kit";
import { AgentMyDataReaderPolicy, createAgentMessagingClient, createMySoMessagingStackClient, messagingPermissionTypes, resolveGenesisMessagingConfig, type DecryptedMessage } from "@socialproof/myso-messaging-stack";
import type { ExecutionScope } from "@/src/core";
import { CustodyVault, PRIMARY_CUSTODY } from "@/src/agent/custody-vault";
import { deriveMySocialLoginSeed } from "@/src/agent/custody-session";
import { R2RoomAttachmentStorage } from "@/src/agent/r2-room-attachment-storage";

type Context = {
    scope: ExecutionScope;
    derivedAddress: string;
    rpcUrl: string;
    socialChain: { packageId: string; memoryConfigId: string; platformObjectId?: string; [key: string]: unknown };
};

const NETWORKS = new Set(["mainnet", "testnet", "devnet", "localnet"]);
function compareRoomOrder(left: number | string, right: number | string): number {
    const a = String(left).replace(/^0+(?=\d)/, "") || "0";
    const b = String(right).replace(/^0+(?=\d)/, "") || "0";
    if (!/^(0|[1-9][0-9]*)$/.test(a) || !/^(0|[1-9][0-9]*)$/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const sameAddress = (left: string, right: string) => normalizeAddress(left) === normalizeAddress(right);
const normalizeAddress = (value: string) => `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;

function optionValue(value: unknown): unknown {
    if (value == null || typeof value === "string" || typeof value === "number") return value ?? null;
    if (typeof value === "object" && !Array.isArray(value)) {
        const record = value as { vec?: unknown; fields?: { vec?: unknown } };
        const vector = record.vec ?? record.fields?.vec;
        if (Array.isArray(vector) && vector.length <= 1) return vector[0] ?? null;
    }
    throw new Error("The on-chain agent has an invalid optional field");
}

async function verifyAgent(client: MySoJsonRpcClient, owner: string, accountId: string, agentId: string, envelope: { packageId: string; publicKey: string; derivedAddress: string }) {
    const read = async (id: string) => {
        const response = await client.getObject({ id, options: { showContent: true } });
        const content = response.data?.content;
        if (!content || content.dataType !== "moveObject") throw new Error("The agent or its account could not be verified on chain");
        return { type: content.type, fields: content.fields as Record<string, unknown> };
    };
    const { type: objectType, fields } = await read(agentId);
    const [pkg, module, type] = objectType.split("::");
    const publicKey = Array.isArray(fields.public_key) ? fields.public_key.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("") : "";
    if (normalizeAddress(pkg ?? "") !== normalizeAddress(envelope.packageId) || module !== "memory" || type !== "SubAgent" || publicKey !== envelope.publicKey || fields.active !== true || normalizeAddress(String(fields.memory_account_id)) !== normalizeAddress(accountId) || normalizeAddress(String(fields.principal_owner)) !== normalizeAddress(owner) || normalizeAddress(String(fields.derived_address)) !== normalizeAddress(envelope.derivedAddress)) throw new Error("The custody envelope does not match the active on-chain agent");
    const expiresAt = optionValue(fields.expires_at);
    if (expiresAt != null && Number(expiresAt) < Date.now()) throw new Error("The on-chain agent has expired");
    let parent = optionValue(fields.parent_object_id);
    const seen = new Set<string>();
    while (typeof parent === "string" && parent) {
        const parentId = normalizeAddress(parent);
        if (seen.has(parentId) || seen.size >= 8) throw new Error("The on-chain agent ancestry is invalid");
        seen.add(parentId);
        const ancestor = await read(parentId);
        const [ancestorPackage, ancestorModule, ancestorType] = ancestor.type.split("::");
        if (normalizeAddress(ancestorPackage ?? "") !== normalizeAddress(envelope.packageId) || ancestorModule !== "memory" || ancestorType !== "SubAgent" || ancestor.fields.active !== true || normalizeAddress(String(ancestor.fields.memory_account_id)) !== normalizeAddress(accountId) || normalizeAddress(String(ancestor.fields.principal_owner)) !== normalizeAddress(owner)) throw new Error("An ancestor agent is inactive or belongs to a different account");
        const ancestorExpiry = optionValue(ancestor.fields.expires_at);
        if (ancestorExpiry != null && Number(ancestorExpiry) < Date.now()) throw new Error("An ancestor agent has expired");
        parent = optionValue(ancestor.fields.parent_object_id);
    }
    const account = await read(accountId);
    const accountObjectFields = account.fields;
    if (!accountObjectFields || accountObjectFields.active !== true || normalizeAddress(String(accountObjectFields.owner)) !== normalizeAddress(owner)) throw new Error("The Memory account is inactive or its owner changed");
    return { platformScope: optionValue(fields.platform_scope) as string | null };
}

export function MySoRoomConversation({ context, room, onReconnect }: { context: Context; room: { groupUuid: string; groupId?: string }; onReconnect: () => Promise<void> }) {
    const account = useCurrentAccount();
    const wallets = useWallets();
    const connect = useConnectWallet();
    const personal = useSignPersonalMessage();
    const signMessageRef = useRef(personal.mutateAsync);
    signMessageRef.current = personal.mutateAsync;
    const network = NETWORKS.has(context.scope.network) ? context.scope.network as "mainnet" | "testnet" | "devnet" | "localnet" : null;
    const client = useMemo(() => network ? new MySoJsonRpcClient({ url: context.rpcUrl, network }) : null, [network, context.rpcUrl]);
    const memoryUrl = process.env.NEXT_PUBLIC_MYSO_MEMORY_URL;
    const relayerUrl = process.env.NEXT_PUBLIC_MYSO_MESSAGING_RELAYER_URL;
    const platformId = context.scope.platformId ?? context.socialChain.platformObjectId;
    const configError = !relayerUrl || !platformId || !context.socialChain.memoryConfigId || !context.socialChain.packageId;
    const vault = useMemo(() => {
        if (!memoryUrl || !client) return null;
        const instance = new CustodyVault(memoryUrl, { accountId: context.scope.accountId, owner: context.scope.owner }, async (message) => {
            if (!account || !sameAddress(account.address, context.scope.owner)) throw new Error("Connect the owner wallet to unlock local agent custody");
            return (await signMessageRef.current({ message, chain: `myso:${context.scope.network}` })).signature;
        }, (agentId, envelope) => verifyAgent(client, context.scope.owner, context.scope.accountId, agentId, envelope));
        instance.setLoginSeedProvider(deriveMySocialLoginSeed);
        return instance;
    }, [memoryUrl, client, context.scope.accountId, context.scope.owner, context.scope.network, account]);
    const [vaultReady, setVaultReady] = useState(false);
    const [messages, setMessages] = useState<DecryptedMessage[]>([]);
    const [reactions, setReactions] = useState<Record<number, Record<string, { count: number; reactors: string[] }>>>({});
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [inviting, setInviting] = useState(false);
    const [inviteAddress, setInviteAddress] = useState("");
    const [inviteNotice, setInviteNotice] = useState("");
    const [text, setText] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [error, setError] = useState("");
    const [preview, setPreview] = useState<{ url: string; name: string; mimeType: string } | null>(null);
    const objectUrl = useRef<string | null>(null);

    useEffect(() => { setVaultReady(false); setMessages([]); setText(""); setFiles([]); setPreview(null); return () => { vault?.lock(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [vault]);

    async function unlock() {
        if (!vault) return;
        setError(""); setLoading(true);
        try { await vault.unlock({ method: PRIMARY_CUSTODY }); setVaultReady(true); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "Agent custody could not be unlocked"); }
        finally { setLoading(false); }
    }

    const getClient = useCallback(async () => {
        if (!client || !vault || !relayerUrl || !platformId) throw new Error("Messaging is not configured for this network. Set the relayer URL and platform object before opening rooms.");
        const agent = await vault.getAgent({ agent_object_id: context.scope.agentId, derived_address: context.derivedAddress, organization_id: context.scope.organizationId ?? null });
        const packageConfig = await resolveGenesisMessagingConfig(client, { rpcUrl: context.rpcUrl, graphqlUrl: process.env.NEXT_PUBLIC_GRAPHQL_URL });
        const messagingClient = createMySoMessagingStackClient(client, {
            mydata: { serverConfigs: [], verifyKeyServers: false },
            encryption: {
                sessionKey: { signer: agent.keypair },
                mydataPolicy: new AgentMyDataReaderPolicy({
                    originalPackageId: packageConfig.messaging.originalPackageId,
                    latestPackageId: packageConfig.messaging.latestPackageId,
                    versionId: packageConfig.messaging.versionId,
                    platformId,
                    memoryConfigId: packageConfig.messaging.memoryConfigId,
                    memoryAccountId: context.scope.accountId,
                    agentDerivedAddress: context.derivedAddress,
                }),
            },
            packageConfig,
            relayer: { relayerUrl },
            attachments: { storageAdapter: new R2RoomAttachmentStorage(), maxAttachments: 10, maxFileSizeBytes: MAX_FILE_BYTES, maxTotalFileSizeBytes: 10 * MAX_FILE_BYTES },
        });
        const agentClient = createAgentMessagingClient({ messaging: messagingClient.messaging, agent: { agentSigner: agent.keypair, subAgentId: context.scope.agentId, principalOwner: context.scope.owner, identityClass: 0, memoryAccountId: context.scope.accountId, platformId } });
        return { messagingClient, agentClient, agent };
    }, [client, context.derivedAddress, context.rpcUrl, context.scope.accountId, context.scope.agentId, context.scope.owner, context.socialChain, platformId, relayerUrl, vault]);

    useEffect(() => {
        if (!vaultReady || configError) return;
        const controller = new AbortController();
        let active = true;
        void (async () => {
            try {
                const { messagingClient, agent } = await getClient();
                const initial = await messagingClient.messaging.listReactions({ signer: agent.keypair, groupRef: { uuid: room.groupUuid } });
                if (!active) return;
                const initialState: typeof reactions = {};
                for (const item of initial) {
                    const byEmoji = initialState[item.chainSeq] ??= {};
                    byEmoji[item.emoji] = { count: item.count, reactors: item.reactors };
                }
                setReactions(initialState);
                for await (const event of messagingClient.messaging.subscribe({ signer: agent.keypair, groupRef: { uuid: room.groupUuid }, signal: controller.signal })) {
                    if (!active) break;
                    if (event.type === "message") {
                        if (!event.message.senderVerified) continue;
                        setMessages((previous) => {
                            const next = previous.filter((item) => item.messageId !== event.message.messageId);
                            next.push(event.message);
                            return next.sort((left, right) => compareRoomOrder(left.order, right.order));
                        });
                    } else if (event.type === "reaction") {
                        setReactions((previous) => ({ ...previous, [event.reaction.chainSeq]: { ...(previous[event.reaction.chainSeq] ?? {}), [event.reaction.emoji]: { count: event.reaction.count, reactors: event.reaction.reactors } } }));
                    }
                }
            } catch (reason) {
                if (active && !controller.signal.aborted) setError(reason instanceof Error ? `Room live updates stopped: ${reason.message}` : "Room live updates stopped");
            }
        })();
        return () => { active = false; controller.abort(); };
    }, [vaultReady, configError, getClient, room.groupUuid]);

    async function refreshMessages() {
        setLoading(true); setError("");
        try {
            if (!vaultReady) throw new Error("Unlock agent custody to read this encrypted room.");
            const { agentClient, messagingClient, agent } = await getClient();
            const result = await agentClient.getMessages({ groupRef: { uuid: room.groupUuid }, limit: 50 });
            setMessages(result.messages);
            const rows = await messagingClient.messaging.listReactions({ signer: agent.keypair, groupRef: { uuid: room.groupUuid } });
            const next: typeof reactions = {};
            for (const row of rows) (next[row.chainSeq] ??= {})[row.emoji] = { count: row.count, reactors: row.reactors };
            setReactions(next);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Room messages could not be loaded"); }
        finally { setLoading(false); }
    }

    async function send() {
        setSending(true); setError("");
        try {
            if (!vaultReady) throw new Error("Unlock agent custody before sending.");
            const chosen = files.map((file) => {
                if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`${file.name} must be between 1 byte and 5 MiB.`);
                return file.arrayBuffer().then((data) => ({ fileName: file.name, mimeType: file.type || "application/octet-stream", data: new Uint8Array(data) }));
            });
            const attachmentFiles = await Promise.all(chosen);
            const { agentClient } = await getClient();
            await agentClient.sendMessage({ groupRef: { uuid: room.groupUuid }, ...(text.trim() ? { text: text.trim() } : {}), ...(attachmentFiles.length ? { files: attachmentFiles } : {}) });
            setText(""); setFiles([]);
            await refreshMessages();
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The room message could not be sent"); }
        finally { setSending(false); }
    }

    async function inviteRoomReader() {
        if (inviting) return;
        setInviting(true); setError(""); setInviteNotice("");
        let digest = "";
        try {
            if (!vaultReady) throw new Error("Unlock local agent custody before inviting a room member.");
            const raw = inviteAddress.trim();
            if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) throw new Error("Enter a valid MySo wallet address.");
            const recipient = normalizeAddress(raw);
            const { messagingClient, agent } = await getClient();
            const groupId = room.groupId ?? messagingClient.messaging.derive.resolveGroupRef({ uuid: room.groupUuid }).groupId;
            const config = await resolveGenesisMessagingConfig(client!, { rpcUrl: context.rpcUrl, graphqlUrl: process.env.NEXT_PUBLIC_GRAPHQL_URL });
            const permissionTypes = messagingPermissionTypes(config.messaging.originalPackageId);
            const extensionAdmin = `${config.permissionedGroups.originalPackageId}::permissioned_group::ExtensionPermissionsAdmin`;
            if (!(await messagingClient.groups.view.hasPermission({ groupId, member: agent.address, permissionType: extensionAdmin }))) {
                throw new Error("The acting agent does not have live extension-permission administration on this room.");
            }
            if (!(await messagingClient.groups.view.hasPermission({ groupId, member: agent.address, permissionType: permissionTypes.MessagingReader }))) {
                throw new Error("The acting agent must be a current room reader before it can invite another reader.");
            }
            const alreadyReader = await messagingClient.groups.view.hasPermission({ groupId, member: recipient, permissionType: permissionTypes.MessagingReader });
            const alreadySender = await messagingClient.groups.view.hasPermission({ groupId, member: recipient, permissionType: permissionTypes.MessagingSender });
            if (alreadyReader && alreadySender) throw new Error("That wallet already has room read and send access.");
            const permissionTypesToGrant = [
                ...(!alreadyReader ? [permissionTypes.MessagingReader] : []),
                ...(!alreadySender ? [permissionTypes.MessagingSender] : []),
            ];
            if (!window.confirm(`Invite ${recipient} to this encrypted room? They will be able to decrypt existing and future messages and attachments. Previously disclosed plaintext cannot be recalled.`)) return;
            const result = await messagingClient.groups.addMembers({
                signer: agent.keypair,
                groupId,
                members: [{ address: recipient, permissions: permissionTypesToGrant }],
            });
            digest = result.digest;
            await client!.waitForTransaction({ digest, timeout: 60_000, pollInterval: 1_000 });
            const [readerVerified, senderVerified] = await Promise.all([
                messagingClient.groups.view.hasPermission({ groupId, member: recipient, permissionType: permissionTypes.MessagingReader }),
                messagingClient.groups.view.hasPermission({ groupId, member: recipient, permissionType: permissionTypes.MessagingSender }),
            ]);
            if (!readerVerified || !senderVerified) throw new Error("The finalized transaction did not grant both room permissions on the current fullnode.");
            setInviteAddress("");
            setInviteNotice(`Room access granted to ${recipient}. They can read existing and future history. Transaction ${digest}.`);
        } catch (reason) {
            setError(reason instanceof Error ? (digest ? `Room invite transaction ${digest} finalized or submitted, but verification failed: ${reason.message}` : reason.message) : "The room invite could not be completed");
        } finally { setInviting(false); }
    }

    async function showAttachment(message: DecryptedMessage, attachmentIndex: number) {
        if (!message.senderVerified) return;
        setError("");
        try {
            const attachment = message.attachments[attachmentIndex];
            if (!attachment) throw new Error("This attachment is unavailable.");
            const bytes = await attachment.data();
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            const url = URL.createObjectURL(new Blob([copy.buffer], { type: attachment.mimeType }));
            objectUrl.current = url;
            setPreview({ url, name: attachment.fileName, mimeType: attachment.mimeType });
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Attachment preview failed"); }
    }

    async function toggleReaction(message: DecryptedMessage, emoji: string) {
        if (!message.senderVerified) return;
        setError("");
        try {
            const { messagingClient, agent } = await getClient();
            const current = reactions[message.order]?.[emoji];
            const alreadyReacted = current?.reactors.some((reactor) => sameAddress(reactor, agent.address)) ?? false;
            const options = { signer: agent.keypair, groupRef: { uuid: room.groupUuid }, order: message.order, emoji };
            if (alreadyReacted) await messagingClient.messaging.removeReaction(options);
            else await messagingClient.messaging.addReaction(options);
            const rows = await messagingClient.messaging.listReactions({ signer: agent.keypair, groupRef: { uuid: room.groupUuid }, order: message.order });
            setReactions((previous) => ({ ...previous, [message.order]: Object.fromEntries(rows.map((row) => [row.emoji, { count: row.count, reactors: row.reactors }])) }));
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The reaction could not be updated"); }
    }

    const walletMatches = !!account && sameAddress(account.address, context.scope.owner);
    return <section className="myso-room-history" aria-label="Encrypted room conversation">
        <div className="myso-room-history-heading"><div><p className="myso-eyebrow">LIVE ENCRYPTED ROOM</p><h3>Conversation</h3></div></div>
        <p className="myso-room-disclosure">Messages are decrypted in this browser or desktop window. Only signature-verified messages and their attachments are shown. R2 stores ciphertext only.</p>
        {configError && <p className="myso-error" role="alert">Room messaging needs a configured relayer, platform object, and Memory package for this network.</p>}
        {!vaultReady && <div className="myso-toolbar">
            {!walletMatches && wallets.map((wallet) => <button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending || loading} onClick={() => void connect.mutateAsync({ wallet, accountAddress: context.scope.owner }).catch((reason) => setError(reason instanceof Error ? reason.message : "Wallet connection failed"))}><Wallet size={16}/>{connect.isPending ? "Connecting…" : `Connect ${wallet.name}`}</button>)}
            <button type="button" className="myso-secondary" disabled={!vault || !walletMatches || loading} onClick={() => void unlock()}><LockKeyhole size={16}/>{loading ? "Unlocking…" : "Unlock local agent custody"}</button>
            <button type="button" className="myso-secondary" disabled={loading} onClick={() => void onReconnect().catch((reason) => setError(reason instanceof Error ? reason.message : "MySocial reconnection failed"))}>Refresh MySocial session</button>
        </div>}
        {vaultReady && <>
            <button type="button" className="myso-secondary" disabled={loading || configError} onClick={() => void refreshMessages()}>{loading ? "Loading messages…" : "Refresh conversation"}</button>
            <section className="myso-room-receipts" aria-label="Invite room member">
                <h3>Invite a room member</h3>
                <p className="myso-room-disclosure">An invite gives this wallet access to existing and future encrypted messages and attachments. It does not transfer room ownership. Removing a member later cannot erase content they already decrypted or exported.</p>
                <label htmlFor="myso-room-invite-address">MySo wallet address</label>
                <input id="myso-room-invite-address" value={inviteAddress} onChange={(event) => setInviteAddress(event.target.value)} maxLength={66} placeholder="0x…" autoComplete="off" />
                <button type="button" className="myso-secondary" disabled={inviting || configError || !inviteAddress.trim()} onClick={() => void inviteRoomReader()}><UserPlus size={16}/>{inviting ? "Verifying and inviting…" : "Invite with room history access"}</button>
                {inviteNotice && <p className="myso-knowledge-note" role="status">{inviteNotice}</p>}
            </section>
            <ol className="myso-room-messages">{messages.map((message) => <li key={message.messageId}>
                <div><span>{message.senderVerified ? "Verified message" : "Unverified message hidden"}</span><small>Order {message.order}</small></div>
                {message.senderVerified && <><p>{message.isDeleted ? "Message deleted" : message.text || (message.attachments.length ? "Attachment" : "")}</p><small>Signature verified · sender {message.senderAddress}</small>{!message.isDeleted&&<div className="myso-room-reactions">{Object.entries(reactions[message.order]??{}).map(([emoji,state])=><button key={emoji} type="button" aria-label={`${emoji} reaction, ${state.count} total`} aria-pressed={state.reactors.some((reactor)=>sameAddress(reactor,context.derivedAddress))} onClick={()=>void toggleReaction(message,emoji)}>{emoji} {state.count}</button>)}<button type="button" aria-label="Add thumbs up reaction" onClick={()=>void toggleReaction(message,"👍")}>＋👍</button></div>}{message.attachments.map((attachment, index) => <button key={`${message.messageId}:${attachment.wire.storageId}`} type="button" className="myso-text-button" onClick={() => void showAttachment(message, index)}><Paperclip size={15}/>{attachment.fileName} · Preview</button>)}</>}
            </li>)}</ol>
            {preview && <div className="myso-room-preview"><div><strong>{preview.name}</strong><button type="button" className="myso-text-button" onClick={() => { URL.revokeObjectURL(preview.url); objectUrl.current = null; setPreview(null); }}>Close preview</button></div>{preview.mimeType.startsWith("image/") ? <img src={preview.url} alt={preview.name}/> : preview.mimeType.startsWith("video/") ? <video src={preview.url} controls/> : preview.mimeType.startsWith("audio/") ? <audio src={preview.url} controls/> : <a href={preview.url} download={preview.name}>Download decrypted attachment</a>}</div>}
            <label htmlFor="myso-room-message">Message</label><textarea id="myso-room-message" value={text} onChange={(event) => setText(event.target.value)} maxLength={8000} placeholder="Write an encrypted room message…"/>
            <label htmlFor="myso-room-files">Attachments (up to 5 MiB each)</label><input id="myso-room-files" type="file" multiple onChange={(event) => { const next = Array.from(event.target.files ?? []); if (next.length > 10 || next.some((file) => file.size > MAX_FILE_BYTES)) { setError("Choose up to 10 files, each no larger than 5 MiB."); event.target.value = ""; setFiles([]); return; } setFiles(next); }}/>
            {files.length > 0 && <small>{files.map((file) => file.name).join(" · ")}</small>}
            <button type="button" className="myso-primary" disabled={sending || configError || (!text.trim() && files.length === 0)} onClick={() => void send()}><Send size={16}/>{sending ? "Encrypting and sending…" : "Send encrypted message"}</button>
        </>}
        {error && <p className="myso-error" role="alert">{error}</p>}
    </section>;
}
