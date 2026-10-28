import { NextResponse } from "next/server";

/** Current chain epoch, read server-side so the browser can build a zkLogin nonce without a fullnode CORS hop. */
export async function GET() {
    const rpc = process.env.NEXT_PUBLIC_MYSO_RPC_URL || process.env.MYSO_RPC_URL || "https://fullnode.testnet.mysocial.network:443";
    const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mysox_getLatestMySoSystemState", params: [] }),
        cache: "no-store",
    });
    const body = (await response.json()) as {
        result?: { epoch?: string | number; epochDurationMs?: string | number; zkloginMaxEpochUpperBoundDelta?: string | number };
    };
    const epoch = Number(body.result?.epoch);
    const duration = Number(body.result?.epochDurationMs);
    const delta = Number(body.result?.zkloginMaxEpochUpperBoundDelta);
    if (!Number.isFinite(epoch)) return NextResponse.json({ error: "Could not read the current epoch." }, { status: 502 });
    return NextResponse.json({
        epoch,
        epochDurationMs: Number.isFinite(duration) && duration > 0 ? duration : 86_400_000,
        maxEpochDelta: Number.isFinite(delta) && delta > 0 ? delta : null,
    });
}
