import { handleMySoPlatformAdmin } from "@/src/server/myso-platform-admin";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){return handleMySoPlatformAdmin(request);}
