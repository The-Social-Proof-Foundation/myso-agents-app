import { handleMySoWork } from "@/src/server/myso-work-api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "task-room", (await context.params).id);
}
