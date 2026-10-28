import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";

const ENVELOPE_VERSION = 1;
const HKDF_INFO = "myso-automation-delegate-v1";
const DELEGATE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export interface MyDataEncryptionKey {
    id: string;
    publicKey: Uint8Array;
}

export interface AutomationDelegateSeed {
    seed: Uint8Array;
    publicKey: Uint8Array;
    address: string;
}

export class AutomationDelegateCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AutomationDelegateCryptoError";
    }
}

export function isValidDelegateName(name: string): boolean {
    return DELEGATE_NAME.test(name);
}

export function delegateKeyRef(name: string): string {
    return `delegate:${name}`;
}

function normalizeObjectId(id: string): string {
    if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(id)) {
        throw new AutomationDelegateCryptoError("A valid MySo account or agent is required.");
    }
    return id.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
}

function decodeBase64Url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new AutomationDelegateCryptoError("The bridge returned an invalid encryption key.");
    }
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse the authenticated bridge response; callers never accept a caller-selected URL. */
export function parseMyDataEncryptionKeys(value: unknown): MyDataEncryptionKey[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AutomationDelegateCryptoError("The automation bridge returned an invalid key list.");
    }
    const keys = (value as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32) {
        throw new AutomationDelegateCryptoError("The automation bridge has no usable encryption key.");
    }
    return keys.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new AutomationDelegateCryptoError("The automation bridge returned an invalid encryption key.");
        }
        const { id, publicKey } = entry as { id?: unknown; publicKey?: unknown };
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof publicKey !== "string") {
            throw new AutomationDelegateCryptoError("The automation bridge returned an invalid encryption key.");
        }
        const decoded = decodeBase64Url(publicKey);
        if (decoded.length !== 32 || encodeBase64Url(decoded) !== publicKey) {
            throw new AutomationDelegateCryptoError("The automation bridge returned an invalid encryption key.");
        }
        return { id, publicKey: decoded };
    });
}

export async function generateAutomationDelegateSeed(): Promise<AutomationDelegateSeed> {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    try {
        const keypair = Ed25519Keypair.fromSecretKey(seed);
        return {
            seed,
            publicKey: keypair.getPublicKey().toRawBytes(),
            address: keypair.toMySoAddress(),
        };
    } catch (error) {
        seed.fill(0);
        throw error;
    }
}

function delegateAad(accountId: string, delegateRef: string, agentObjectId: string): Uint8Array {
    if (!isValidDelegateName(delegateRef)) {
        throw new AutomationDelegateCryptoError("The delegate name is invalid.");
    }
    return new TextEncoder().encode(
        `myso-delegate-v1|${normalizeObjectId(accountId)}|${delegateRef}|${normalizeObjectId(agentObjectId)}`,
    );
}

/** Encrypt only in the client, matching the automation bridge's X25519/HKDF/AES-GCM format. */
export async function encryptAutomationDelegateSeed(
    seed: Uint8Array,
    recipient: MyDataEncryptionKey,
    accountId: string,
    delegateRef: string,
    agentObjectId: string,
): Promise<string> {
    if (seed.length !== 32 || recipient.publicKey.length !== 32) {
        throw new AutomationDelegateCryptoError("The delegate or bridge key has an invalid length.");
    }
    if (!globalThis.crypto?.subtle) {
        throw new AutomationDelegateCryptoError("This browser cannot perform the required delegate-key encryption.");
    }

    const subtle = crypto.subtle;
    const ephemeral = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const ephemeralPublic = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
    const recipientPublic = await subtle.importKey("raw", recipient.publicKey as BufferSource, { name: "X25519" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: recipientPublic }, ephemeral.privateKey, 256));
    const salt = new Uint8Array(64);
    salt.set(ephemeralPublic, 0);
    salt.set(recipient.publicKey, 32);

    try {
        const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
        const aesKey = await subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(HKDF_INFO) as BufferSource },
            hkdf,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt"],
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const body = new Uint8Array(await subtle.encrypt(
            { name: "AES-GCM", iv: iv as BufferSource, additionalData: delegateAad(accountId, delegateRef, agentObjectId) as BufferSource, tagLength: 128 },
            aesKey,
            seed as BufferSource,
        ));
        const envelope = new Uint8Array(1 + ephemeralPublic.length + iv.length + body.length);
        envelope[0] = ENVELOPE_VERSION;
        envelope.set(ephemeralPublic, 1);
        envelope.set(iv, 33);
        envelope.set(body, 45);
        return encodeBase64Url(envelope);
    } catch {
        throw new AutomationDelegateCryptoError("The delegate key could not be encrypted for the automation bridge.");
    } finally {
        shared.fill(0);
        salt.fill(0);
    }
}
