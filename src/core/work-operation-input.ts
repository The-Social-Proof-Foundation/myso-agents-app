import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

/** Replace large upload bytes with their digest before journaling a work input. */
export function normalizeWorkOperationInput(toolName: string, input: JsonRecord): JsonRecord {
    if (toolName !== "task_upload_deliverable") return input;
    const request = record(input.request);
    if (!request) throw new Error("Task artifact upload request is unavailable");
    let contentDigestHex = request.contentDigestHex;
    if (typeof request.contentBase64 === "string") {
        const bytes = Buffer.from(request.contentBase64, "base64");
        if (!bytes.length || bytes.toString("base64") !== request.contentBase64) throw new Error("Task artifact content is not canonical base64");
        contentDigestHex = createHash("sha256").update(bytes).digest("hex");
    }
    if (typeof contentDigestHex !== "string" || !/^[0-9a-f]{64}$/.test(contentDigestHex)) throw new Error("Task artifact content digest is unavailable");
    const metadata = { ...request };
    delete metadata.contentBase64;
    return { ...input, request: { ...metadata, contentDigestHex } };
}

export function canonicalWorkOperationInput(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalWorkOperationInput).join(",")}]`;
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalWorkOperationInput(object[key])}`).join(",")}}`;
}

export function workOperationInputHash(toolName: string, input: JsonRecord): string {
    return createHash("sha256").update(canonicalWorkOperationInput(normalizeWorkOperationInput(toolName, input))).digest("hex");
}
