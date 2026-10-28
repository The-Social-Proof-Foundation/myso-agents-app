import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; operationId: string }> }) {
    const { id, operationId } = await context.params;
    const url = new URL(request.url);
    url.searchParams.set("operationId", operationId);
    return handleMySoWork(new Request(url, request), "run-operation-receipt", id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string; operationId: string }> }) {
    const { id, operationId } = await context.params;
    const url = new URL(request.url);
    url.searchParams.set("operationId", operationId);
    return handleMySoWork(new Request(url, request), "run-operation-receipt", id);
}
