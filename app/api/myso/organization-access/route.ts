import { handleMySoOrganizationAccess } from "@/src/server/myso-organization-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleMySoOrganizationAccess(request);
}
