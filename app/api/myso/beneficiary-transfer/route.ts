import { handleMySoBeneficiaryTransfer } from "@/src/server/myso-beneficiary-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleMySoBeneficiaryTransfer(request);
}
