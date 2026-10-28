import { handleMySoWork } from "@/src/server/myso-work-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    return handleMySoWork(request, "cancel-run", (await context.params).id);
}
