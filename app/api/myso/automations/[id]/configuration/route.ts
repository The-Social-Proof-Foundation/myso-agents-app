import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "automation-configuration-validate", (await context.params).id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "automation-configuration-update", (await context.params).id);
}
