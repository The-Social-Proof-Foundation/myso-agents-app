const MAX_FILES = 10;
const MAX_SOURCE_BYTES = 480 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024;

export interface TaskDeliveryManifestEntry {
    archivePath: string;
    originalName: string;
    contentLength: number;
    mediaType: string;
    sha256Hex: string;
}

export interface TaskDeliveryPackage {
    bytes: Uint8Array;
    digestHex: string;
    manifest: TaskDeliveryManifestEntry[];
    contentLength: number;
}

interface ZipEntry {
    name: Uint8Array;
    bytes: Uint8Array;
    crc32: number;
    offset: number;
}

const encoder = new TextEncoder();

function safeName(input: string): string {
    const basename = input.normalize("NFC").split(/[\\/]/).at(-1) ?? "";
    const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
    if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Each file needs a safe filename.");
    if (encoder.encode(cleaned).byteLength > 120) throw new Error("Filenames must be 120 UTF-8 bytes or less.");
    return cleaned;
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function write32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }

function zipStored(entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    const records: ZipEntry[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = encoder.encode(entry.path);
        const checksum = crc32(entry.bytes);
        const local = new Uint8Array(30 + name.length + entry.bytes.length);
        const localView = new DataView(local.buffer);
        write32(localView, 0, 0x04034b50); write16(localView, 4, 20); write16(localView, 6, 0x0800);
        write16(localView, 8, 0); write16(localView, 10, 0); write16(localView, 12, 33);
        write32(localView, 14, checksum); write32(localView, 18, entry.bytes.length); write32(localView, 22, entry.bytes.length);
        write16(localView, 26, name.length); write16(localView, 28, 0);
        local.set(name, 30); local.set(entry.bytes, 30 + name.length);
        localParts.push(local); records.push({ name, bytes: entry.bytes, crc32: checksum, offset }); offset += local.length;
    }
    for (const record of records) {
        const central = new Uint8Array(46 + record.name.length);
        const view = new DataView(central.buffer);
        write32(view, 0, 0x02014b50); write16(view, 4, 20); write16(view, 6, 20); write16(view, 8, 0x0800);
        write16(view, 10, 0); write16(view, 12, 0); write16(view, 14, 33);
        write32(view, 16, record.crc32); write32(view, 20, record.bytes.length); write32(view, 24, record.bytes.length);
        write16(view, 28, record.name.length); write16(view, 30, 0); write16(view, 32, 0); write16(view, 34, 0); write16(view, 36, 0);
        write32(view, 38, 0); write32(view, 42, record.offset); central.set(record.name, 46); centralParts.push(central);
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22); const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50); write16(endView, 4, 0); write16(endView, 6, 0);
    write16(endView, 8, records.length); write16(endView, 10, records.length); write32(endView, 12, centralSize);
    write32(endView, 16, offset); write16(endView, 20, 0);
    const result = new Uint8Array(offset + centralSize + end.length); let cursor = 0;
    for (const part of localParts) { result.set(part, cursor); cursor += part.length; }
    for (const part of centralParts) { result.set(part, cursor); cursor += part.length; }
    result.set(end, cursor);
    return result;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function taskDeliverySelectionKey(taskId: string, files: File[]): string {
    return `${taskId}:${files.map((file) => `${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`).join("|")}`;
}

export async function buildTaskDeliveryPackage(files: File[]): Promise<TaskDeliveryPackage> {
    if (files.length < 1 || files.length > MAX_FILES) throw new Error(`Select between 1 and ${MAX_FILES} files.`);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.some((file) => file.size < 1) || totalBytes > MAX_SOURCE_BYTES) {
        throw new Error(`Selected files must contain up to ${Math.floor(MAX_SOURCE_BYTES / 1024)} KiB in total.`);
    }
    const names = files.map((file) => safeName(file.name));
    const manifest: TaskDeliveryManifestEntry[] = [];
    const archiveEntries: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const [index, file] of files.entries()) {
        const originalName = names[index];
        if (!originalName) throw new Error("The selected file list changed while it was being packaged.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength !== file.size) throw new Error(`Could not read ${originalName} completely.`);
        const archivePath = `files/${String(index + 1).padStart(3, "0")}-${originalName}`;
        manifest.push({ archivePath, originalName, contentLength: bytes.byteLength, mediaType: file.type || "application/octet-stream", sha256Hex: await sha256(bytes) });
        archiveEntries.push({ path: archivePath, bytes });
    }
    archiveEntries.push({ path: "myso-delivery-manifest.json", bytes: encoder.encode(JSON.stringify({ format: "myso.task-delivery.v1", files: manifest }, null, 2)) });
    const bytes = zipStored(archiveEntries);
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("The packaged ZIP exceeds the 512 KiB task delivery limit; remove files or reduce their size.");
    return { bytes, digestHex: await sha256(bytes), manifest, contentLength: bytes.byteLength };
}

export async function verifyTaskDeliveryPackage(bytes: Uint8Array, expectedDigestHex: string): Promise<TaskDeliveryManifestEntry[]> {
    if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES || await sha256(bytes) !== expectedDigestHex.toLowerCase()) {
        throw new Error("The downloaded ZIP does not match the finalized task artifact digest.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read16 = (offset: number) => view.getUint16(offset, true);
    const read32 = (offset: number) => view.getUint32(offset, true);
    const endOffset = bytes.byteLength - 22;
    if (read32(endOffset) !== 0x06054b50 || read16(endOffset + 20) !== 0) throw new Error("The task package has an unsupported ZIP ending.");
    const entryCount = read16(endOffset + 10);
    const centralSize = read32(endOffset + 12);
    const centralOffset = read32(endOffset + 16);
    if (entryCount < 2 || entryCount > MAX_FILES + 1 || centralOffset + centralSize !== endOffset) throw new Error("The task package directory is invalid.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const extracted = new Map<string, { bytes: Uint8Array; crc: number }>();
    const localOffsets = new Set<number>();
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
        if (cursor + 46 > endOffset || read32(cursor) !== 0x02014b50) throw new Error("The task package directory contains an invalid entry.");
        const flags = read16(cursor + 8); const method = read16(cursor + 10); const crc = read32(cursor + 16);
        const compressedSize = read32(cursor + 20); const uncompressedSize = read32(cursor + 24);
        const nameLength = read16(cursor + 28); const extraLength = read16(cursor + 30); const commentLength = read16(cursor + 32);
        const localOffset = read32(cursor + 42);
        const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
        if (recordEnd > endOffset || flags !== 0x0800 || method !== 0 || compressedSize !== uncompressedSize || uncompressedSize > MAX_PACKAGE_BYTES) throw new Error("The task package uses unsupported or unsafe ZIP metadata.");
        const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        if (extracted.has(path) || (path !== "myso-delivery-manifest.json" && !/^files\/[0-9]{3}-[^/\\]+$/.test(path)) || localOffsets.has(localOffset)) throw new Error("The task package contains a duplicate or unsafe path.");
        localOffsets.add(localOffset);
        if (localOffset + 30 > centralOffset || read32(localOffset) !== 0x04034b50) throw new Error("A task package file header is invalid.");
        const localNameLength = read16(localOffset + 26); const localExtraLength = read16(localOffset + 28);
        const localPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataStart + uncompressedSize;
        if (localPath !== path || dataEnd > centralOffset || read32(localOffset + 14) !== crc || read32(localOffset + 18) !== uncompressedSize || read32(localOffset + 22) !== uncompressedSize || read16(localOffset + 6) !== flags || read16(localOffset + 8) !== method) {
            throw new Error("A task package file header did not match its directory record.");
        }
        const content = bytes.slice(dataStart, dataEnd);
        if (crc32(content) !== crc) throw new Error(`A task package file failed its CRC check: ${path}`);
        extracted.set(path, { bytes: content, crc });
        cursor = recordEnd;
    }
    if (cursor !== endOffset) throw new Error("The task package directory has trailing or missing records.");
    const manifestEntry = extracted.get("myso-delivery-manifest.json");
    if (!manifestEntry) throw new Error("The task package is missing its file manifest.");
    let document: unknown;
    try { document = JSON.parse(decoder.decode(manifestEntry.bytes)); }
    catch { throw new Error("The task package manifest is not valid JSON."); }
    if (!document || typeof document !== "object" || (document as { format?: unknown }).format !== "myso.task-delivery.v1" || !Array.isArray((document as { files?: unknown }).files)) {
        throw new Error("The task package manifest has an unsupported format.");
    }
    const manifest = (document as { files: unknown[] }).files;
    if (manifest.length !== entryCount - 1 || manifest.length < 1 || manifest.length > MAX_FILES) throw new Error("The task package manifest does not describe every file.");
    const verified: TaskDeliveryManifestEntry[] = [];
    const manifestPaths = new Set<string>();
    for (const [index, candidate] of manifest.entries()) {
        if (!candidate || typeof candidate !== "object") throw new Error("The task package manifest contains an invalid file record.");
        const entry = candidate as Partial<TaskDeliveryManifestEntry>;
        if (typeof entry.archivePath !== "string" || typeof entry.originalName !== "string" || typeof entry.contentLength !== "number" || !Number.isSafeInteger(entry.contentLength) || typeof entry.mediaType !== "string" || entry.mediaType.length > 200 || typeof entry.sha256Hex !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256Hex)) {
            throw new Error("The task package manifest contains an invalid file record.");
        }
        const expectedPath = `files/${String(index + 1).padStart(3, "0")}-${safeName(entry.originalName)}`;
        if (entry.archivePath !== expectedPath || manifestPaths.has(entry.archivePath)) throw new Error("The task package manifest contains a duplicate or unsafe file path.");
        manifestPaths.add(entry.archivePath);
        const file = extracted.get(entry.archivePath);
        if (!file || file.bytes.byteLength !== entry.contentLength || await sha256(file.bytes) !== entry.sha256Hex.toLowerCase()) throw new Error(`A task package file failed its manifest digest check: ${entry.originalName}`);
        verified.push(entry as TaskDeliveryManifestEntry);
    }
    if (extracted.size !== manifestPaths.size + 1) throw new Error("The ZIP contains files not described by the task manifest.");
    return verified;
}
