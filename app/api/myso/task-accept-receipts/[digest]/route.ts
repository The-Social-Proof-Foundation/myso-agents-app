import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ digest: string }> }) {
    return handleMySoWork(request, "task-accept-receipt", (await context.params).digest);
}
