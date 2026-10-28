import { mySoErrorResponse, selectMySoBoundAgent } from "@/src/server/myso-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        const body = await request.json() as { agentObjectId?: unknown };
        const agentObjectId = body.agentObjectId === null || body.agentObjectId === undefined ? null : body.agentObjectId;
        if (agentObjectId !== null && (typeof agentObjectId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(agentObjectId))) {
            return Response.json({ error: "Select an agent id from this account" }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        return await selectMySoBoundAgent(request, agentObjectId);
    } catch (error) {
        return mySoErrorResponse(error);
    }
}
