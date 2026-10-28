import { logoutDesktopMySoSession } from "@/src/server/myso";
export const runtime = "nodejs";
export async function POST(request: Request) { return logoutDesktopMySoSession(request); }
