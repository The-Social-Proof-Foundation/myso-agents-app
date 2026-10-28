import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const id = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const digest = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const same = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase().padStart(64, "0") === b.replace(/^0x/i, "").toLowerCase().padStart(64, "0");

async function readBody(req: Request) {
    if (!req.headers.get("content-type")?.includes("application/json") || !req.body) throw new MySoAccessError(415, "Send a JSON request");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 16_384) throw new MySoAccessError(413, "Asset transfer request is too large"); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MySoAccessError(400, "Asset transfer request is not valid JSON"); }
}

const requestSchema = z.object({ operation: z.literal("request"), objectId: id, recipient: id, objectType: z.string().min(1).max(512), idempotencyKey }).strict();
const approveSchema = z.object({ operation: z.literal("approve"), approvalId: z.uuid(), walletSignature: z.string().min(80).max(4096) }).strict();
const prepareSchema = z.object({ operation: z.literal("prepare"), objectId: id, recipient: id, objectType: z.string().min(1).max(512), idempotencyKey, approvalId: z.uuid() }).strict();
const submitSchema = z.object({ operation: z.literal("submit"), idempotencyKey, approvalId: z.uuid(), digest, walletSignature: z.string().min(1).max(4096) }).strict();
const receiptSchema = z.object({ operation: z.literal("receipt"), digest }).strict();

export async function handleMySoAssetTransfer(req: Request): Promise<Response> {
    try {
        if (req.method !== "POST") throw new MySoAccessError(405, "Use POST for owner-approved asset transfers");
        const auth = await authenticatedMySo(req); const raw = await readBody(req);
        if (!raw || typeof raw !== "object" || !("operation" in raw)) throw new MySoAccessError(400, "An asset transfer operation is required");
        const operation = (raw as { operation: unknown }).operation;
        if (operation === "request") {
            const input = requestSchema.parse(raw);
            if (same(input.recipient, auth.scope.owner)) throw new MySoAccessError(400, "Choose a recipient other than the current owner");
            const owned = await auth.mcp.callTool("assets_get_owned_object", { id: input.objectId }, req.signal);
            if (!owned.ok) throw new MySoAccessError(409, "The selected object is no longer available from the configured fullnode");
            const object = z.object({ objectId: id, objectType: z.string().min(1).max(512), owner: id, evidenceSource: z.literal("configured_fullnode") }).passthrough().parse(owned.data);
            if (!same(object.objectId, input.objectId) || !same(object.owner, auth.scope.owner) || object.objectType !== input.objectType) throw new MySoAccessError(409, "The selected object's owner or exact type changed; refresh the inventory");
            const approval = await auth.mcp.callTool("assets_transfer_object", { objectId: input.objectId, recipient: input.recipient, objectType: input.objectType, idempotencyKey: input.idempotencyKey, expiresInSeconds: 600 }, req.signal);
            if (!approval.ok) throw new MySoAccessError(409, "The exact owner approval request could not be created");
            const result = z.object({ approvalId: z.uuid().optional(), approval_id: z.uuid().optional(), approvalIntent: z.string().min(1).optional(), approval_intent: z.string().min(1).optional(), expiresAtMs: z.number().optional(), expires_at_ms: z.number().optional() }).passthrough().parse(approval.data);
            const approvalId = result.approvalId ?? result.approval_id; const approvalIntent = result.approvalIntent ?? result.approval_intent;
            if (!approvalId || !approvalIntent) throw new MySoAccessError(502, "The approval response omitted its signed intent");
            return Response.json({ objectId: input.objectId, recipient: input.recipient, objectType: input.objectType, idempotencyKey: input.idempotencyKey, approvalId, approvalIntent, registryAction: "assets.transfer_object.v1", expiresAtMs: result.expiresAtMs ?? result.expires_at_ms }, { headers: HEADERS });
        }
        if (operation === "approve") {
            const input = approveSchema.parse(raw); const result = await auth.mcp.callTool("chain_approve_action", { approvalId: input.approvalId, walletSignature: input.walletSignature }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The owner signature was not accepted for this exact object transfer");
            return Response.json({ approvalId: input.approvalId, approved: true }, { headers: HEADERS });
        }
        if (operation === "prepare") {
            const input = prepareSchema.parse(raw); const parameters = { objectId: input.objectId, recipient: input.recipient, objectType: input.objectType };
            const result = await auth.mcp.callTool("chain_prepare_approved_action", { registryAction: "assets.transfer_object.v1", parameters, idempotencyKey: input.idempotencyKey, approvalId: input.approvalId }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The approved object transfer is stale or could not be prepared");
            const prepared = z.object({ bytes: z.string().min(1), digest }).passthrough().parse(result.data);
            return Response.json({ ...parameters, idempotencyKey: input.idempotencyKey, approvalId: input.approvalId, registryAction: "assets.transfer_object.v1", ...prepared }, { headers: HEADERS });
        }
        if (operation === "submit") {
            const input = submitSchema.parse(raw); const result = await auth.mcp.callTool("chain_submit_approved_action", { registryAction: "assets.transfer_object.v1", idempotencyKey: input.idempotencyKey, approvalId: input.approvalId, digest: input.digest, walletSignature: input.walletSignature }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The signed transaction was not accepted; check the same digest before retrying");
            return Response.json({ submitted: true, digest: input.digest, registryAction: "assets.transfer_object.v1" }, { headers: HEADERS });
        }
        if (operation === "receipt") {
            const input = receiptSchema.parse(raw); const result = await auth.mcp.callTool("assets_get_transfer_receipt", { id: input.digest }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The scoped fullnode transfer receipt is not available yet");
            const receipt = z.object({ digest, registryAction: z.literal("assets.transfer_object.v1"), status: z.enum(["finalized", "checkpoint_pending", "failed", "unknown"]), objectChange: z.record(z.string(), z.unknown()).nullable().optional(), evidenceSource: z.string().min(1) }).passthrough().parse(result.data);
            if (receipt.digest !== input.digest) throw new MySoAccessError(502, "The asset receipt digest did not match the submitted transaction");
            return Response.json(receipt, { headers: HEADERS });
        }
        throw new MySoAccessError(400, "Unsupported asset transfer operation");
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "The asset transfer request or service response had an unsupported format" }, { status: 400, headers: HEADERS });
        return mySoErrorResponse(error);
    }
}
