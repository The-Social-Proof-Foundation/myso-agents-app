import { NextResponse } from "next/server";
import { zkLoginProveUrl, zkLoginProverNetwork } from "@/src/server/zklogin-service";

export const maxDuration = 300;

const PROVE_TIMEOUT_MS = 280_000;

export async function POST(request: Request) {
    const proveUrl = zkLoginProveUrl();
    if (!proveUrl) {
        return NextResponse.json(
            { error: "MYSO_ZKLOGIN_PROVER_URL or ZKLOGIN_PROVER_URL is not set. Proofs must come from a prover loaded with zklogin_myso_final.zkey." },
            { status: 500 },
        );
    }
    const rawBody = await request.text();
    let forwardBody = rawBody;
    try {
        const parsed = JSON.parse(rawBody) as { network?: string };
        if (parsed && typeof parsed === "object") {
            parsed.network = zkLoginProverNetwork(parsed.network);
            forwardBody = JSON.stringify(parsed);
        }
    } catch {
        // Non-JSON body — forward unchanged.
    }
    let response: Response;
    try {
        response = await fetch(proveUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: forwardBody,
            cache: "no-store",
            signal: AbortSignal.timeout(PROVE_TIMEOUT_MS),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "zkLogin prover request failed";
        console.error("[zklogin/prove] upstream request failed", message);
        return NextResponse.json({ error: `zkLogin prover did not respond in time. ${message}` }, { status: 504 });
    }
    return new NextResponse(await response.text(), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
}
