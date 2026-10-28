import { handleMySoAuth } from "@/src/server/myso";

export const runtime = "nodejs";
export async function GET(request: Request) { return handleMySoAuth(request, "start"); }
