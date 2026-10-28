import { authenticatedMySo, mySoErrorResponse } from "@/src/server/myso-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        const body = await request.json() as { mydataId?: unknown };
        if (typeof body.mydataId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(body.mydataId)) {
            return Response.json({ error: "A revoked listing id is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        const auth = await authenticatedMySo(request);
        const result = await auth.mcp.callTool("work_run_purge_revoked_listing", { request: { mydataId: body.mydataId } }, request.signal);
        if (!result.ok) return Response.json({ error: result.error?.message ?? "Revoked listing copies could not be cleared" }, { status: 502, headers: { "Cache-Control": "no-store" } });
        return Response.json(result.data ?? { purged: 0 }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return mySoErrorResponse(error);
    }
}
