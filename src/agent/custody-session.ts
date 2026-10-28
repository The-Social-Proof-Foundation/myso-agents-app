let accessToken: string | null = null;

/** OAuth capability held only in this renderer memory for the custody ceremony. */
export function setCustodyAccessToken(value: string | null): void {
    accessToken = value && value.length <= 4096 && /^[A-Za-z0-9._~+\/-]+=*$/.test(value) ? value : null;
}

export async function deriveMySocialLoginSeed(): Promise<Uint8Array> {
    const token = accessToken;
    if (!token) throw new Error("Reconnect MySocial to unlock the local agent custody vault.");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("This MySocial session cannot unlock the custody vault.");
    let payload: unknown;
    try {
        const encoded = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
        payload = JSON.parse(atob(encoded.padEnd(encoded.length + ((4 - encoded.length % 4) % 4), "=")));
    } catch { throw new Error("This MySocial session cannot unlock the custody vault."); }
    const sub = payload && typeof payload === "object" ? (payload as {sub?: unknown}).sub : undefined;
    if (typeof sub !== "string" || !sub.trim() || sub.startsWith("wallet:") || sub.includes("://")) {
        throw new Error("This MySocial session does not include the account identity needed for custody.");
    }
    const saltUrl = process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL || "https://salt.testnet.mysocial.network/salt";
    const response = await fetch(`${saltUrl.replace(/\/$/, "")}/zklogin-salt`, {
        headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}, cache: "no-store",
    });
    if (!response.ok) throw new Error("MySocial could not provide the login salt needed to unlock agent custody.");
    const body = await response.json() as {salt?: unknown};
    if (typeof body.salt !== "string" || !body.salt) throw new Error("MySocial did not return the login salt needed to unlock agent custody.");
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sub}_${body.salt}`))).slice(0, 32);
}
