import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
    return handleMySoWork(request, "automation-run-reconcile", (await context.params).runId);
}
