import { handleMySoActionApprovals } from "@/src/server/myso-action-approvals";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function POST(request:Request){return handleMySoActionApprovals(request);}
