import { handleMySoAuth, completeDesktopMySoAuth } from "@/src/server/myso";
export const runtime = "nodejs";
export async function GET(request: Request) {
    return new URL(request.url).searchParams.get("state")?.startsWith("desktop.") ? completeDesktopMySoAuth(request) : handleMySoAuth(request, "callback");
}
