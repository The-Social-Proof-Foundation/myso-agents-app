import { handleMySoOwnerRotationManifest } from "@/src/server/myso-owner-rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    return handleMySoOwnerRotationManifest(request);
}
