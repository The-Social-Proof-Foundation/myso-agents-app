import { handleMySoBeneficiaryAcceptance } from "@/src/server/myso-beneficiary-acceptance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleMySoBeneficiaryAcceptance(request);
}
