import { handleMySoWork } from "@/src/server/myso-work-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ uuid: string }> }) {
    return handleMySoWork(request, "room-receipts", (await context.params).uuid);
}

export async function POST(request: Request, context: { params: Promise<{ uuid: string }> }) {
    return handleMySoWork(request, "room-receipts", (await context.params).uuid);
}
