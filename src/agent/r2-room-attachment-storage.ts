import { roomAttachmentDownloadSchema, roomAttachmentUploadSchema } from "../core/contracts/messaging.ts";

type StorageEntry = { name: string; data: Uint8Array };
type RoomUploadContext = { groupRef: { groupId: string; encryptionHistoryId: string } };

/**
 * Client-side adapter for the messaging SDK. It receives only bytes already
 * encrypted by the room DEK and routes them through authenticated MCP/R2 APIs.
 */
export class R2RoomAttachmentStorage {
    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async upload(entries: StorageEntry[], context?: RoomUploadContext): Promise<{ ids: string[]; metadata: { storage: "cloudflare_r2" } }> {
        const groupId = context?.groupRef.groupId;
        if (!groupId || !/^0x[0-9a-fA-F]{1,64}$/.test(groupId)) throw new Error("Room attachment upload requires a resolved group ID.");
        if (!entries.length || entries.length > 10) throw new Error("Room attachment batches must contain 1–10 files.");
        const responses = await Promise.all(entries.map(async (entry) => {
            if (!entry.data.byteLength || entry.data.byteLength > 5 * 1024 * 1024) throw new Error("Encrypted room attachments must be 1–5 MiB.");
            const contentBase64 = encodeBase64(entry.data);
            const idempotencyKey = await attachmentIdempotencyKey(entry.data);
            const response = await this.fetchImpl("/api/myso/rooms/attachments/upload", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ groupId, contentBase64, idempotencyKey }),
                cache: "no-store",
            });
            const payload: unknown = await response.json().catch(() => null);
            if (!response.ok) throw new Error(readError(payload, "Encrypted room attachment upload failed."));
            const stored = roomAttachmentUploadSchema.parse(payload);
            if (!sameId(stored.groupId, groupId) || !storageRefMatchesGroup(stored.storageId, groupId) || stored.contentLength !== entry.data.byteLength || stored.sha256Hex !== await digest(entry.data)) {
                throw new Error("R2 upload confirmation does not match the encrypted room attachment.");
            }
            return stored.storageId;
        }));
        return { ids: responses, metadata: { storage: "cloudflare_r2" } };
    }

    async download(storageId: string): Promise<Uint8Array> {
        const response = await this.fetchImpl("/api/myso/rooms/attachments/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storageId }),
            cache: "no-store",
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(readError(payload, "Encrypted room attachment download failed."));
        const stored = roomAttachmentDownloadSchema.parse(payload);
        if (!sameStorageRef(stored.storageId, storageId)) throw new Error("R2 returned a different room attachment reference.");
        const bytes = decodeBase64(stored.contentBase64);
        if (bytes.byteLength !== stored.contentLength || await digest(bytes) !== stored.sha256Hex) throw new Error("R2 attachment failed its length or digest check.");
        return bytes;
    }
}

async function digest(bytes: Uint8Array): Promise<string> {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input.buffer));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function attachmentIdempotencyKey(bytes: Uint8Array): Promise<string> {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input.buffer));
    const id = hash.slice(0, 16);
    id[6] = (id[6]! & 0x0f) | 0x50;
    id[8] = (id[8]! & 0x3f) | 0x80;
    const hex = Array.from(id, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameId(left: string, right: string): boolean {
    const normalize = (value: string) => value.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    return normalize(left) === normalize(right);
}

function storageRefMatchesGroup(storageId: string, groupId: string): boolean {
    const match = /^r2room:\/\/(0x[0-9a-fA-F]{1,64})\/[0-9a-fA-F-]{36}$/.exec(storageId);
    return Boolean(match && sameId(match[1]!, groupId));
}

function sameStorageRef(left: string, right: string): boolean {
    const parse = (value: string) => /^r2room:\/\/(0x[0-9a-fA-F]{1,64})\/([0-9a-fA-F-]{36})$/.exec(value);
    const a = parse(left);
    const b = parse(right);
    return Boolean(a && b && sameId(a[1]!, b[1]!) && a[2]!.toLowerCase() === b[2]!.toLowerCase());
}

function readError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
    return fallback;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}
