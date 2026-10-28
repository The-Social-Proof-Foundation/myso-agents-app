import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "@/src/server/myso-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const memorySchema = z.object({
    accountId: z.string(),
    available: z.boolean(),
    updatedAt: z.string().nullable(),
    entries: decimal.nullable(),
    bytes: decimal.nullable(),
    orgSharedEntries: decimal.nullable(),
    agents: z.array(z.object({
        agentObjectId: z.string(),
        organizationId: z.string().nullable(),
        entries: decimal,
        bytes: decimal,
        orgSharedEntries: decimal,
        updatedAt: z.string(),
    })).max(500),
}).strict();
const balanceSchema = z.object({
    available_mist: decimal,
    balance: z.object({ balance_mist: decimal, spent_total_mist: decimal, reserved_mist: decimal }).passthrough(),
}).passthrough();

export async function GET(request: Request) {
    try {
        const auth = await authenticatedMySo(request);
        const memoryResult = await auth.mcp.callTool("account_get_memory_usage", {}, request.signal);
        if (!memoryResult.ok) throw new MySoAccessError(502, "Stored memory usage is unavailable for this account");
        const memory = memorySchema.parse(memoryResult.data);
        if (memory.available === (memory.entries === null)) throw new MySoAccessError(502, "Stored memory usage did not match its snapshot");
        let ai: { unavailable: true; error: string } | { unavailable: false; balance: z.infer<typeof balanceSchema>; usage: unknown[] };
        try {
            const balanceResult = await auth.mcp.callTool("ai_get_balance", {}, request.signal);
            const usageResult = await auth.mcp.callTool("ai_list_usage", { limit: 20 }, request.signal);
            if (!balanceResult.ok || !usageResult.ok || !Array.isArray(usageResult.data)) throw new Error("AI credit usage is unavailable for this account");
            ai = { unavailable: false, balance: balanceSchema.parse(balanceResult.data), usage: usageResult.data.slice(0, 20) };
        } catch (error) {
            ai = { unavailable: true, error: error instanceof Error ? error.message : "AI credit usage is unavailable for this account" };
        }
        return Response.json({ memory, ai }, { headers });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Account usage returned an unsupported snapshot" }, { status: 502, headers });
        return mySoErrorResponse(error);
    }
}
