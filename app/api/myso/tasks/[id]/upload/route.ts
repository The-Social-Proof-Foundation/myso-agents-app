import { handleMySoWork } from "@/src/server/myso-work-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "task-upload", (await context.params).id);
}
