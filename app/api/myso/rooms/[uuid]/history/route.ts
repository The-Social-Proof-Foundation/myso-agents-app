import { handleMySoWork } from "@/src/server/myso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ uuid: string }> }) {
    return handleMySoWork(request, "room-history", (await context.params).uuid);
}
