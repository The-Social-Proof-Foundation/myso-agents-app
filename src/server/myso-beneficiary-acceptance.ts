import { z } from "zod";
import { assertMySoRequestOrigin, authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const digestSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const schema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("request"), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), idempotencyKey: keySchema }).strict(),
    z.object({ operation: z.literal("approve"), approvalId: z.string().uuid(), walletSignature: z.string().min(80).max(4096) }).strict(),
    z.object({ operation: z.literal("prepare"), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), approvalId: z.string().uuid(), idempotencyKey: keySchema }).strict(),
    z.object({ operation: z.literal("submit"), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), approvalId: z.string().uuid(), idempotencyKey: keySchema, digest: digestSchema, walletSignature: z.string().min(1).max(4096) }).strict(),
    z.object({ operation: z.literal("receipt"), digest: digestSchema, beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }).strict(),
]);

async function readBody(req: Request): Promise<unknown> {
    if (!req.headers.get("content-type")?.includes("application/json") || !req.body) throw new MySoAccessError(415, "Send a JSON request");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16 * 1024) throw new MySoAccessError(413, "Beneficiary acceptance request is too large"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new MySoAccessError(400, "Request is not valid JSON"); }
}

export async function handleMySoBeneficiaryAcceptance(req: Request): Promise<Response> {
    try {
        assertMySoRequestOrigin(req);
        const auth = await authenticatedMySo(req);
        const input = schema.parse(await readBody(req));
        let result;
        if (input.operation === "request") {
            result = await auth.mcp.callTool("poc_accept_beneficiary_transfer", { beneficiaryId: input.beneficiaryId, idempotencyKey: input.idempotencyKey, expiresInSeconds: 600 }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The exact recipient approval request could not be created");
            const value = z.object({ approvalId: z.string().uuid().optional(), approval_id: z.string().uuid().optional(), approvalIntent: z.string().min(1).optional(), approval_intent: z.string().min(1).optional() }).passthrough().parse(result.data);
            const approvalId = value.approvalId ?? value.approval_id; const approvalIntent = value.approvalIntent ?? value.approval_intent;
            if (!approvalId || !approvalIntent) throw new MySoAccessError(502, "The recipient approval response omitted its signed intent");
            return Response.json({ approvalId, approvalIntent, idempotencyKey: input.idempotencyKey, beneficiaryId: input.beneficiaryId }, { headers: HEADERS });
        }
        if (input.operation === "approve") {
            result = await auth.mcp.callTool("chain_approve_action", { approvalId: input.approvalId, walletSignature: input.walletSignature }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The recipient wallet signature was not accepted");
            return Response.json({ approvalId: input.approvalId, approved: true }, { headers: HEADERS });
        }
        if (input.operation === "prepare") {
            result = await auth.mcp.callTool("chain_prepare_approved_action", { registryAction: "poc.accept_beneficiary_transfer.v1", parameters: { beneficiaryId: input.beneficiaryId }, idempotencyKey: input.idempotencyKey, approvalId: input.approvalId }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The approved recipient transaction could not be prepared against current chain state");
            const value = z.object({ bytes: z.string().min(1), digest: digestSchema }).passthrough().parse(result.data);
            return Response.json({ approvalId: input.approvalId, beneficiaryId: input.beneficiaryId, idempotencyKey: input.idempotencyKey, registryAction: "poc.accept_beneficiary_transfer.v1", bytes: value.bytes, digest: value.digest }, { headers: HEADERS });
        }
        if (input.operation === "submit") {
            result = await auth.mcp.callTool("chain_submit_approved_action", { registryAction: "poc.accept_beneficiary_transfer.v1", idempotencyKey: input.idempotencyKey, approvalId: input.approvalId, digest: input.digest, walletSignature: input.walletSignature }, req.signal);
            if (!result.ok) throw new MySoAccessError(409, "The signed recipient transaction could not be submitted");
            return Response.json({ approvalId: input.approvalId, digest: input.digest, submitted: true }, { headers: HEADERS });
        }
        result = await auth.mcp.callTool("poc_get_beneficiary_transfer_receipt", { id: input.digest }, req.signal);
        if (!result.ok) throw new MySoAccessError(409, "No finalized recipient acceptance receipt is available yet");
        if (Buffer.byteLength(JSON.stringify(result.data), "utf8") > 32 * 1024) throw new MySoAccessError(502, "Acceptance receipt exceeds the supported response size");
        const value = z.object({ digest: digestSchema, status: z.enum(["finalized", "checkpoint_pending", "failed", "unknown"]), beneficiaryId: z.string() }).passthrough().parse(result.data);
        if (value.digest !== input.digest || value.status !== "finalized") throw new MySoAccessError(409, "The acceptance transaction has not reached checkpoint finality yet");
        if (value.beneficiaryId.replace(/^0x/i, "").toLowerCase().padStart(64, "0") !== input.beneficiaryId.replace(/^0x/i, "").toLowerCase().padStart(64, "0")) throw new MySoAccessError(409, "The finalized receipt does not match the selected beneficiary");
        return Response.json({ receipt: result.data, digest: value.digest, status: value.status, beneficiaryId: input.beneficiaryId }, { headers: HEADERS });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Beneficiary acceptance request is invalid" }, { status: 400, headers: HEADERS });
        return mySoErrorResponse(error);
    }
}
