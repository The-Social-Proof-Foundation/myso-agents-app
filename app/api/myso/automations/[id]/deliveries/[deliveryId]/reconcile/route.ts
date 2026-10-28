import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ deliveryId: string }> }) {
    return handleMySoWork(request, "automation-reconcile", (await context.params).deliveryId);
}
