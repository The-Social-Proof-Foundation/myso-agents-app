import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ uuid: string }> }) {
    return handleMySoWork(request, "room-name", (await context.params).uuid);
}
