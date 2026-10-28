import { computeZkLoginAddress } from "@socialproof/myso/zklogin";
import { NextResponse } from "next/server";
import { zkLoginSaltOrigin } from "@/src/server/zklogin-service";

function jwtPayload(token: string): { sub?: string; iss?: string; aud?: string | string[] } {
    const part = token.split(".")[1] ?? "";
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as { sub?: string; iss?: string; aud?: string | string[] };
}

/** Recompute the zkLogin address from the stored salt and bind it. The client address is not trusted. */
export async function POST(request: Request) {
    const authorization = request.headers.get("authorization");
    if (!authorization?.toLowerCase().startsWith("bearer ")) {
        return NextResponse.json({ error: "Bearer token required" }, { status: 401 });
    }
    const accessToken = authorization.slice(authorization.indexOf(" ") + 1).trim();
    const saltResponse = await fetch(`${zkLoginSaltOrigin()}/zklogin-salt`, {
        headers: { authorization },
        cache: "no-store",
    });
    if (!saltResponse.ok) return new NextResponse(await saltResponse.text(), { status: saltResponse.status });
    const saltRow = (await saltResponse.json()) as { salt?: string; iss?: string; aud?: string };
    if (!saltRow.salt || !saltRow.iss || !saltRow.aud) {
        return NextResponse.json({ error: "zkLogin salt is incomplete" }, { status: 409 });
    }
    const sessionSub = jwtPayload(accessToken).sub;
    const prefix = `${saltRow.iss}:`;
    if (!sessionSub?.startsWith(prefix)) {
        return NextResponse.json({ error: "Session does not match this zkLogin account" }, { status: 403 });
    }
    const claimValue = sessionSub.slice(prefix.length);
    if (!claimValue) return NextResponse.json({ error: "Session subject is missing" }, { status: 403 });
    const body = (await request.json().catch(() => ({}))) as { id_token?: string };
    if (body.id_token) {
        const claims = jwtPayload(body.id_token);
        const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
        if (claims.iss !== saltRow.iss || claims.sub !== claimValue || aud !== saltRow.aud) {
            return NextResponse.json({ error: "OAuth token does not match this zkLogin account" }, { status: 403 });
        }
    }
    const address = computeZkLoginAddress({
        claimName: "sub",
        claimValue,
        iss: saltRow.iss,
        aud: saltRow.aud,
        userSalt: saltRow.salt,
        legacyAddress: false,
    });
    const saved = await fetch(`${zkLoginSaltOrigin()}/zklogin-address`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ address }),
        cache: "no-store",
    });
    if (!saved.ok) return new NextResponse(await saved.text(), { status: saved.status });
    return NextResponse.json({ address });
}
