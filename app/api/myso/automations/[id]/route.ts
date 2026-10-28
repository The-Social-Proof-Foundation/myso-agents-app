import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "automation-enabled", (await context.params).id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "automation-rename", (await context.params).id);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "automation-delete", (await context.params).id);
}
