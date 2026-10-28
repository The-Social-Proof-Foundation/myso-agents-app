import { handleMySoPrivateData } from "@/src/server/myso-private-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
    return handleMySoPrivateData(request, "purchase");
}
