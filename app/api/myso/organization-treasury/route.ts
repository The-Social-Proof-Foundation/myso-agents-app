import { handleMySoOrganizationTreasury } from "@/src/server/myso-organization-treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleMySoOrganizationTreasury(request);
}
