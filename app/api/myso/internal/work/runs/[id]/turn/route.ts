import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const workerSchema = z.object({
    keyRef: z.string().regex(/^delegate:[A-Za-z0-9._-]{1,64}$/),
    accountId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    parentAgentId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    workerAgentId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    runId: z.uuid(),
    credential: z.string().regex(/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i),
}).strict();
const envelopeSchema = z.object({ worker: workerSchema, turn: z.unknown() }).strict();

function authorized(request: Request): boolean {
    const expected = process.env.MYSO_AGENTS_WORKER_DISPATCH_SECRET;
    const supplied = request.headers.get("x-myso-worker-secret");
    if (!expected || expected.length < 32 || !supplied || /[\r\n]/.test(expected) || /[\r\n]/.test(supplied)) return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function boundedJson(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.includes("application/json") || !request.body) throw new Error("invalid body");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > 32 * 1024) throw new Error("body too large");
            chunks.push(item.value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!authorized(request)) return Response.json({ error: "Run dispatch is unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) return Response.json({ error: "Invalid work run" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    let raw: unknown;
    try { raw = await boundedJson(request); } catch (error) {
        const tooLarge = error instanceof Error && error.message === "body too large";
        return Response.json({ error: tooLarge ? "Run dispatch request is too large" : "Run dispatch request is invalid" }, { status: tooLarge ? 413 : 400, headers: { "Cache-Control": "no-store" } });
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.worker.runId !== id) return Response.json({ error: "Run dispatch binding is invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const turnRequest = new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify(parsed.data.turn),
        signal: request.signal,
    });
    return handleMySoWork(turnRequest, "turn", id, parsed.data.worker);
}
