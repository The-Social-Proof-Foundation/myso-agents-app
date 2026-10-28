import { handleMySoWork } from "@/src/server/myso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    return handleMySoWork(request, "automation-delegates");
}

export async function POST(request: Request) {
    return handleMySoWork(request, "automation-store-delegate");
}
