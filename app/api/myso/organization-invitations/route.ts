import { handleMySoOrganizationInvitations } from "@/src/server/myso-organization-invitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleMySoOrganizationInvitations(request);
}
