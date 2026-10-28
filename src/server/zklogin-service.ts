/** Salt service origin. The public routes are `/zklogin-salt` and `/zklogin-address`, not under `/salt`. */
export function zkLoginSaltOrigin(): string {
    const raw = process.env.MYSOCIAL_SALT_API_URL || process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL || "https://salt.testnet.mysocial.network";
    return raw.trim().replace(/\/+$/, "").replace(/\/salt$/, "");
}

/** Prover endpoint. Accepts either the service origin or a URL that already ends in `/prove`. */
export function zkLoginProveUrl(): string | null {
    const raw = process.env.MYSO_ZKLOGIN_PROVER_URL || process.env.ZKLOGIN_PROVER_URL;
    if (!raw?.trim()) return null;
    const endpoint = raw.trim().replace(/\/$/, "");
    return endpoint.endsWith("/prove") || endpoint.endsWith("/v1") ? endpoint : `${endpoint}/prove`;
}

/** Ceremony label the prover expects. A local fullnode still proves against testnet parameters. */
export function zkLoginProverNetwork(requested?: string): "mainnet" | "testnet" {
    const fromEnv = process.env.ZKLOGIN_PROVER_NETWORK || process.env.NEXT_PUBLIC_ZKLOGIN_PROVER_NETWORK || requested;
    return fromEnv === "mainnet" ? "mainnet" : "testnet";
}
