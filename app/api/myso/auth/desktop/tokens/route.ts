import { acceptDesktopSessionTokens } from "@/src/server/myso";
export const runtime = "nodejs";
export async function POST(request: Request) { return acceptDesktopSessionTokens(request); }
