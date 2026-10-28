import { handleMySoWork } from "@/src/server/myso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ view: string }> }) { return handleMySoWork(request, "view", (await context.params).view); }
