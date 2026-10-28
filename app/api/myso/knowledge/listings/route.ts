import { handleMySoPrivateData } from "@/src/server/myso.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleMySoPrivateData(request, "listings");
}
