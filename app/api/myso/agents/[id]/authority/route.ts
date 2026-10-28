import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "owner-agent-authority", (await context.params).id);
}
