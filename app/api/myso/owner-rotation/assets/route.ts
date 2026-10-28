import { handleMySoAssetTransfer } from "@/src/server/myso-asset-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleMySoAssetTransfer(request);
}
