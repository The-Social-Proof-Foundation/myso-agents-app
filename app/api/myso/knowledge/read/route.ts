import { handleMySoPrivateData } from "@/src/server/myso";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){return handleMySoPrivateData(request,"read");}
