import { refreshDesktopMySoSession } from "@/src/server/myso";
export const runtime = "nodejs";
export async function POST(request: Request) { return refreshDesktopMySoSession(request); }
