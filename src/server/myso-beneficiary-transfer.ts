import { z } from "zod";
import { assertMySoRequestOrigin, authenticatedMySo, MySoAccessError, mySoErrorResponse, readMySoBrowserSession } from "./myso-auth.ts";

const requestSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("start"), identityHash: z.string().regex(/^0x[0-9a-fA-F]{2,64}$/), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }).strict(),
    z.object({ operation: z.literal("status"), identityHash: z.string().regex(/^0x[0-9a-fA-F]{2,64}$/), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }).strict(),
    z.object({ operation: z.literal("propose"), identityHash: z.string().regex(/^0x[0-9a-fA-F]{2,64}$/), beneficiaryId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), recipientAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }).strict(),
    z.object({ operation: z.literal("job"), identityHash: z.string().regex(/^0x[0-9a-fA-F]{2,64}$/), jobId: z.string().uuid() }).strict(),
]);

function oracleUrl(): URL {
    const value = process.env.MYSO_POC_ORACLE_URL;
    if (!value) throw new MySoAccessError(503, "PoC oracle service is not configured");
    const parsed = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
        throw new MySoAccessError(503, "PoC oracle URL must use HTTPS or a loopback development URL");
    }
    return parsed;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok || !response.body) throw new MySoAccessError(response.status === 404 ? 404 : 502, "PoC beneficiary service could not complete this request");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16 * 1024) throw new MySoAccessError(502, "PoC beneficiary service returned an oversized response");
            chunks.push(part.value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes))); }
    catch (error) { if (error instanceof MySoAccessError) throw error; throw new MySoAccessError(502, "PoC beneficiary service returned invalid data"); }
}

export async function handleMySoBeneficiaryTransfer(req: Request): Promise<Response> {
    try {
        assertMySoRequestOrigin(req);
        const auth = await authenticatedMySo(req);
        if (!req.headers.get("content-type")?.includes("application/json") || !req.body) throw new MySoAccessError(415, "Send a JSON request");
        const reader = req.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 4096) throw new MySoAccessError(413, "Request is too large");
                chunks.push(part.value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size);
        let byteOffset = 0;
        for (const chunk of chunks) { bytes.set(chunk, byteOffset); byteOffset += chunk.byteLength; }
        let raw: unknown;
        try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new MySoAccessError(400, "Request is not valid JSON"); }
        const input = requestSchema.parse(raw);
        const configured = oracleUrl();
        const base = configured.toString().replace(/\/$/, "");
        const authHeader = req.headers.get("authorization");
        const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : readMySoBrowserSession(req).token;
        const headers = { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" };
        const network = encodeURIComponent(auth.scope.network);
        const identity = encodeURIComponent(input.identityHash);
        const beneficiary = input.operation === "job" ? "" : encodeURIComponent(input.beneficiaryId);
        let response: Response;
        if (input.operation === "start") {
            response = await fetch(`${base}/oracle/beneficiaries/${identity}/transfer/oauth/start?network=${network}`, { method: "POST", headers, body: JSON.stringify({ claimant_address: auth.scope.owner, beneficiary_id: input.beneficiaryId }), redirect: "error", cache: "no-store", signal: req.signal });
        } else if (input.operation === "status") {
            response = await fetch(`${base}/oracle/beneficiaries/${identity}/transfer/status?claimant_address=${encodeURIComponent(auth.scope.owner)}&network=${network}`, { headers, redirect: "error", cache: "no-store", signal: req.signal });
        } else if (input.operation === "propose") {
            response = await fetch(`${base}/oracle/beneficiaries/${identity}/transfer-proposal?network=${network}`, { method: "POST", headers, body: JSON.stringify({ verified_wallet: auth.scope.owner, recipient_address: input.recipientAddress, beneficiary_id: input.beneficiaryId }), redirect: "error", cache: "no-store", signal: req.signal });
        } else {
            response = await fetch(`${base}/oracle/beneficiary-transfer-jobs/${input.jobId}?identity_hash=${identity}&verified_wallet=${encodeURIComponent(auth.scope.owner)}`, { headers, redirect: "error", cache: "no-store", signal: req.signal });
        }
        const data = await jsonResponse(response);
        if (input.operation === "start" && (typeof data.authorize_url !== "string" || new URL(data.authorize_url).protocol !== "https:")) throw new MySoAccessError(502, "Identity service did not return a secure authorization link");
        if (input.operation === "propose" && (data.status !== "queued" || typeof data.job_id !== "string")) throw new MySoAccessError(502, "PoC oracle did not queue the beneficiary transfer proposal");
        return Response.json(data, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Beneficiary transfer request is invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
        return mySoErrorResponse(error);
    }
}
