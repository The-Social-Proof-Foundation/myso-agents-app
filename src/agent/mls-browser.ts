/**
 * Browser MLS (E2EE) for agents in this app: each agent wallet is its own MLS device here, with
 * the same model as the MySocial chat app.
 *
 * - State (the agent's MLS keys, group states and its only readable copies of messages) lives in
 *   IndexedDB. Every record is AES-256-GCM sealed under a non-extractable key, with the record id
 *   in the AAD.
 * - Exactly one tab per agent owns the device (Web Lock `myso-mls:<agent>`). Other tabs see
 *   `waiting` until it's free.
 * - The session is opened once per page and agent; each messaging client for that agent reuses it
 *   (`openMlsSession` attaches it to the client).
 *
 * Every new room is created as an MLS room (`e2ee=mls1`), so this is required to read or send.
 */

"use client";

import { MlsGroupUnavailableError, MlsMembersUnverifiedError, type MlsSession, type MlsStateStore, type MlsWasmModule, type MySoMessagingStackClient, type UnwrappedRow } from "@socialproof/myso-messaging-stack";
import type { Signer } from "@socialproof/myso/cryptography";

// --- Sealed IndexedDB store ---------------------------------------------------------------

const STORE = "kv";
const DEVICE_KEY = "__device_key__";

function openDb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
    });
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function encode(value: unknown): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $b: hex(v) } : typeof v === "bigint" ? { $n: v.toString() } : v)));
}

function decode<T>(bytes: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(bytes), (_k, v) =>
        v && typeof v === "object" && "$b" in v ? unhex(v.$b) : v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v,
    ) as T;
}

type Sealed = { iv: Uint8Array; ct: ArrayBuffer };

export class IndexedDbMlsStore implements MlsStateStore {
    readonly #name: string;
    #db: Promise<IDBDatabase> | null = null;
    #key: Promise<CryptoKey> | null = null;

    constructor(wallet: string) {
        this.#name = `myso-agents-mls-${wallet.toLowerCase()}`;
    }

    #open() {
        this.#db ??= openDb(this.#name);
        return this.#db;
    }

    #deviceKey() {
        this.#key ??= (async () => {
            const db = await this.#open();
            const existing = await tx(db, "readonly", (s) => s.get(DEVICE_KEY));
            if (existing instanceof CryptoKey) return existing;
            const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
            await tx(db, "readwrite", (s) => s.put(key, DEVICE_KEY));
            return key;
        })();
        return this.#key;
    }

    async #put(id: string, value: unknown) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, await this.#deviceKey(), encode(value));
        await tx(await this.#open(), "readwrite", (s) => s.put({ iv, ct } satisfies Sealed, id));
    }

    async #unseal<T>(id: string, sealed: Sealed | undefined): Promise<T | null> {
        if (!sealed?.iv) return null;
        try {
            const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(id) }, await this.#deviceKey(), sealed.ct);
            return decode<T>(new Uint8Array(pt));
        } catch {
            return null;
        }
    }

    async #get<T>(id: string): Promise<T | null> {
        return this.#unseal<T>(id, (await tx(await this.#open(), "readonly", (s) => s.get(id))) as Sealed | undefined);
    }

    #rowKey(groupId: string, order: number, messageId: string) {
        return `row:${groupId}:${String(order).padStart(16, "0")}:${messageId}`;
    }

    loadDevice() {
        return this.#get<{ snapshot: Uint8Array; deviceId: string }>("device");
    }
    saveDevice(state: { snapshot: Uint8Array; deviceId: string }) {
        return this.#put("device", state);
    }
    async getCursor(groupId: string) {
        return (await this.#get<number>(`cursor:${groupId}`)) ?? 0;
    }
    setCursor(groupId: string, order: number) {
        return this.#put(`cursor:${groupId}`, order);
    }
    async putRows(groupId: string, rows: UnwrappedRow[]) {
        for (const row of rows) await this.#put(this.#rowKey(groupId, row.order, row.messageId), row);
    }
    async listRows(groupId: string, options: { before?: number; limit: number }) {
        const db = await this.#open();
        const upper = options.before === undefined ? `row:${groupId};` : `row:${groupId}:${String(options.before).padStart(16, "0")}`;
        const range = IDBKeyRange.bound(`row:${groupId}:`, upper, false, true);
        const [keys, values] = await Promise.all([tx(db, "readonly", (s) => s.getAllKeys(range)), tx(db, "readonly", (s) => s.getAll(range))]);
        const out: UnwrappedRow[] = [];
        for (let i = Math.max(0, keys.length - options.limit); i < keys.length; i++) {
            const row = await this.#unseal<UnwrappedRow>(String(keys[i]), values[i] as Sealed);
            if (row) out.push(row);
        }
        return out;
    }
    async hasRows(groupId: string, rows: { order: number; messageId: string }[]) {
        const db = await this.#open();
        const found = new Set<string>();
        for (const r of rows) {
            if ((await tx(db, "readonly", (s) => s.getKey(this.#rowKey(groupId, r.order, r.messageId)))) !== undefined) found.add(`${r.order}:${r.messageId}`);
        }
        return found;
    }
    async groupIds() {
        const keys = await tx(await this.#open(), "readonly", (s) => s.getAllKeys(IDBKeyRange.bound("row:", "row;", false, true)));
        return [...new Set(keys.map((k) => String(k).split(":").slice(1, -2).join(":")))];
    }
    getMeta(key: string) {
        return this.#get<string>(`meta:${key}`);
    }
    async setMeta(key: string, value: string | null) {
        if (value === null) await tx(await this.#open(), "readwrite", (s) => s.delete(`meta:${key}`));
        else await this.#put(`meta:${key}`, value);
    }
    async clear() {
        await tx(await this.#open(), "readwrite", (s) => s.clear());
        this.#key = null;
    }
}

// --- Runtime ------------------------------------------------------------------------------

let wasm: Promise<MlsWasmModule> | null = null;
function loadWasm(): Promise<MlsWasmModule> {
    wasm ??= import("@socialproof/myso-mls").then(async (mod) => {
        await (mod.default as () => Promise<unknown>)();
        return mod as unknown as MlsWasmModule;
    });
    return wasm;
}

function deviceIdFor(wallet: string): string {
    const key = `myso-agents-mls-device:${wallet.toLowerCase()}`;
    try {
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const fresh = `web-${crypto.randomUUID()}`;
        localStorage.setItem(key, fresh);
        return fresh;
    } catch {
        return `web-${crypto.randomUUID()}`;
    }
}

export type AgentMlsState = "ready" | "waiting" | "unsupported" | "failed";

type Held = { session: MlsSession; store: IndexedDbMlsStore };
const held = new Map<string, Promise<Held | null>>();
const waiting = new Set<string>();
let lastState: AgentMlsState = "ready";

/** Open (once) this agent's MLS device in this tab, holding its Web Lock for the page's life. */
function acquire(messagingClient: MySoMessagingStackClient, signer: Signer, wallet: string): Promise<Held | null> {
    let pending = held.get(wallet);
    if (pending) return pending;
    pending = (async () => {
        if (typeof navigator === "undefined" || !navigator.locks) return null;
        const mls = await loadWasm();
        return new Promise<Held | null>((resolve) => {
            waiting.add(wallet);
            void navigator.locks.request(`myso-mls:${wallet}`, async () => {
                waiting.delete(wallet);
                const store = new IndexedDbMlsStore(wallet);
                try {
                    const session = await messagingClient.openMlsSession({ wasm: mls, store, signer, deviceId: deviceIdFor(wallet), primary: true });
                    resolve({ session, store });
                } catch (error) {
                    console.warn("[mls] agent device failed to open:", error);
                    held.delete(wallet);
                    resolve(null);
                    return;
                }
                await new Promise<never>(() => {}); // hold the lock for this page's lifetime
            });
        });
    })();
    held.set(wallet, pending);
    return pending;
}

/**
 * Make `messagingClient` read and send through this agent's MLS device. Resolves `waiting` (after
 * `waitMs`) while another tab owns the device; the device opens in the background once it's free.
 */
export async function ensureAgentMls(messagingClient: MySoMessagingStackClient, signer: Signer, waitMs = 4_000): Promise<AgentMlsState> {
    if (typeof navigator === "undefined" || !navigator.locks || typeof indexedDB === "undefined") return "unsupported";
    const wallet = signer.toMySoAddress().toLowerCase();
    const opened = acquire(messagingClient, signer, wallet);
    const result = await Promise.race([opened, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), waitMs))]);
    if (result === "timeout") return (lastState = waiting.has(wallet) ? "waiting" : "failed");
    if (!result) return (lastState = "failed");
    lastState = "ready";
    // Another messaging client for the same agent: share the one live session (never open a second).
    if (messagingClient.mlsSession !== result.session) messagingClient.attachMlsSession(result.session, { primary: true });
    return "ready";
}

/** User-facing copy for an MLS state that isn't `ready`. */
export function agentMlsMessage(state: AgentMlsState): string {
    switch (state) {
        case "waiting":
            return "This agent's encrypted rooms are open in another tab. Close that tab to use them here.";
        case "unsupported":
            return "This browser can't run encrypted rooms (it needs IndexedDB and Web Locks).";
        default:
            return "Encrypted rooms couldn't start in this tab. Reload to try again.";
    }
}

/** Readable copy for room errors; MLS states get an explanation instead of the SDK message. */
export function roomErrorMessage(reason: unknown, fallback: string): string {
    if (reason instanceof MlsMembersUnverifiedError) {
        return "A member's device in this room is still being verified, so nothing was sent. Try again in a moment.";
    }
    if (reason instanceof MlsGroupUnavailableError) {
        return reason.reason === "no-device" ? agentMlsMessage(lastState === "ready" ? "failed" : lastState) : "Setting up encryption for this room on this device… Try again in a few seconds.";
    }
    return reason instanceof Error ? reason.message : fallback;
}
