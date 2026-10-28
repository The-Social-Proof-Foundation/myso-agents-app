import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import {
    decodeJwt,
    genAddressSeed,
    generateNonce,
    generateRandomness,
    getExtendedEphemeralPublicKey,
    jwtToAddress,
} from "@socialproof/myso/zklogin";

const DEFAULT_MAX_EPOCH_DELTA = 30;

type Pending = {
    ephemeral: Ed25519Keypair;
    randomness: string;
    maxEpoch: number;
    nonce: string;
};

let pending: Pending | null = null;

/** Chain nonce for the hosted login window. The OAuth token is only provable when it carries this nonce. */
export async function beginZkLoginNonce(): Promise<string> {
    const ephemeral = new Ed25519Keypair();
    const randomness = generateRandomness();
    const clock = await chainClock();
    const maxEpoch = clock.epoch + (clock.maxEpochDelta ?? DEFAULT_MAX_EPOCH_DELTA);
    const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);
    pending = { ephemeral, randomness, maxEpoch, nonce };
    return nonce;
}

/**
 * Prove the OAuth login and return the official zkLogin address.
 * The address is recomputed by the salt service after the prover accepts the proof.
 */
export async function proveZkLoginAddress(jwt: string, accessToken: string): Promise<string> {
    const active = pending;
    if (!active) throw new Error("zkLogin nonce expired. Sign in again.");
    const claims = jwtClaims(jwt);
    if (claims.nonce !== active.nonce) throw new Error("OAuth token nonce does not match zkLogin.");
    const decoded = decodeJwt(jwt);
    if (!decoded.sub || !decoded.iss || !decoded.aud) throw new Error("OAuth token is missing zkLogin claims.");
    const salt = await saltFor(accessToken, decoded.iss, decoded.aud);
    const addressSeed = genAddressSeed(salt, "sub", decoded.sub, decoded.aud).toString();
    const localAddress = jwtToAddress(jwt, salt, false);
    const prove = await fetch("/api/zklogin/prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jwt,
            extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(active.ephemeral.getPublicKey()),
            maxEpoch: active.maxEpoch,
            jwtRandomness: active.randomness,
            salt,
            addressSeed,
            issBase64Details: extractIssClaim(jwt),
            headerBase64: jwt.split(".")[0],
            keyClaimName: "sub",
            network: "testnet",
        }),
        signal: AbortSignal.timeout(280_000),
    });
    if (!prove.ok) throw new Error(await proverError(prove));
    acceptProof(await prove.json(), jwt);
    const bound = await fetch("/api/zklogin/address", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: jwt }),
    });
    const derived = (await bound.json().catch(() => ({}))) as { address?: string; error?: string };
    if (!bound.ok || typeof derived.address !== "string") {
        throw new Error(derived.error || `Could not bind the zkLogin address (${bound.status}).`);
    }
    if (derived.address.toLowerCase() !== localAddress.toLowerCase()) {
        throw new Error("Salt address did not match the zkLogin wallet address.");
    }
    pending = null;
    return derived.address;
}

async function chainClock(): Promise<{ epoch: number; maxEpochDelta: number | null }> {
    const response = await fetch("/api/zklogin/clock", { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as { epoch?: number; maxEpochDelta?: number | null; error?: string };
    if (!response.ok || !Number.isFinite(body.epoch)) throw new Error(body.error || "Could not read the current epoch.");
    return { epoch: body.epoch as number, maxEpochDelta: body.maxEpochDelta ?? null };
}

async function saltFor(accessToken: string, iss: string, aud: string): Promise<string> {
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
    const existing = await fetch("/api/zklogin/salt", { headers });
    if (existing.ok) {
        const body = (await existing.json()) as { salt?: string };
        if (body.salt) return body.salt;
    }
    const salt = BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`).toString();
    const saved = await fetch("/api/zklogin/salt", { method: "PUT", headers, body: JSON.stringify({ salt, iss, aud }) });
    if (saved.status === 409) {
        const again = await fetch("/api/zklogin/salt", { headers });
        const body = (await again.json()) as { salt?: string };
        if (!body.salt) throw new Error("Could not store the zkLogin salt.");
        return body.salt;
    }
    if (!saved.ok) throw new Error("Could not store the zkLogin salt.");
    return salt;
}

async function proverError(response: Response): Promise<string> {
    const raw = await response.text();
    try {
        const body = JSON.parse(raw) as { error?: string; message?: string };
        return body.error || body.message || "zkLogin prover could not build a proof.";
    } catch {
        return raw.trim().slice(0, 240) || "zkLogin prover could not build a proof.";
    }
}

function jwtClaims(jwt: string): { nonce?: string; iss?: string } {
    const payload = jwt.split(".")[1] ?? "";
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    return JSON.parse(json) as { nonce?: string; iss?: string };
}

function base64UrlBits(value: string): number[] {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bits: number[] = [];
    for (const char of value) {
        const index = alphabet.indexOf(char);
        if (index < 0) throw new Error("Invalid token encoding.");
        for (let shift = 5; shift >= 0; shift -= 1) bits.push((index >> shift) & 1);
    }
    return bits;
}

function decodePackedClaim(value: string, index: number): string {
    let bits = base64UrlBits(value);
    const first = index % 4;
    if (first === 1) bits = bits.slice(2);
    else if (first === 2) bits = bits.slice(4);
    else if (first !== 0) throw new Error("Issuer claim is not packed.");
    const last = (index + value.length - 1) % 4;
    if (last === 2) bits = bits.slice(0, -2);
    else if (last === 1) bits = bits.slice(0, -4);
    else if (last !== 3) throw new Error("Issuer claim is not packed.");
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2);
    return new TextDecoder().decode(bytes);
}

function extractIssClaim(jwt: string): { value: string; indexMod4: number } {
    const payload = jwt.split(".")[1] ?? "";
    for (let start = 0; start < payload.length; start += 1) {
        if (start % 4 === 3) continue;
        for (let end = start + 8; end <= payload.length; end += 1) {
            const last = (start + (end - start) - 1) % 4;
            if (last === 0) continue;
            try {
                const decoded = decodePackedClaim(payload.slice(start, end), start);
                if (!decoded.startsWith('"iss":') || (!decoded.endsWith(",") && !decoded.endsWith("}"))) continue;
                const parsed = JSON.parse(`{${decoded.slice(0, -1)}}`) as { iss?: string };
                if (typeof parsed.iss === "string" && Object.keys(parsed).length === 1) {
                    return { value: payload.slice(start, end), indexMod4: start % 4 };
                }
            } catch {
                // This window is not the issuer claim.
            }
        }
    }
    throw new Error("OAuth token is missing the issuer claim.");
}

function elementToDecimal(element: string): string {
    if (/^[0-9]+$/.test(element)) return element;
    const bytes = Uint8Array.from(atob(element), (char) => char.charCodeAt(0));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return BigInt(`0x${hex || "0"}`).toString();
}

function decimalTriple(value: string[] | { e0?: { element?: string }; e1?: { element?: string }; e2?: { element?: string } }): string[] {
    if (Array.isArray(value)) return value.map(elementToDecimal);
    return ["e0", "e1", "e2"].map((key) => elementToDecimal(value[key as "e0" | "e1" | "e2"]?.element ?? ""));
}

function decimalPairs(value: string[][] | Record<string, { element?: string }>): string[][] {
    if (Array.isArray(value)) return value.map((pair) => pair.map(elementToDecimal));
    return [["e01", "e00"], ["e11", "e10"], ["e20", "e21"]].map((pair) => pair.map((key) => elementToDecimal(value[key]?.element ?? "")));
}

function acceptProof(body: {
    proofPoints?: {
        a?: string[] | { e0?: { element?: string }; e1?: { element?: string }; e2?: { element?: string } };
        b?: string[][] | Record<string, { element?: string }>;
        c?: string[] | { e0?: { element?: string }; e1?: { element?: string }; e2?: { element?: string } };
    };
}, jwt: string): void {
    const points = body.proofPoints;
    if (!points?.a || !points.b || !points.c) throw new Error("zkLogin prover returned an incomplete proof.");
    const proofPoints = { a: decimalTriple(points.a), b: decimalPairs(points.b), c: decimalTriple(points.c) };
    const decimal = (value: string) => /^[0-9]+$/.test(value);
    const acceptable = proofPoints.a.length === 3 && proofPoints.c.length === 3
        && proofPoints.a.every(decimal) && proofPoints.c.every(decimal)
        && proofPoints.a[2] === "1" && proofPoints.c[2] === "1"
        && proofPoints.b.length === 3
        && proofPoints.b.every((pair) => pair.length === 2 && pair.every(decimal))
        && proofPoints.b[2]?.[0] === "1" && proofPoints.b[2]?.[1] === "0"
        && (jwt.split(".")[0]?.length ?? 0) > 0;
    if (!acceptable) throw new Error("zkLogin prover returned proof points the chain will not accept.");
}
