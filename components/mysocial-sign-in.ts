import { beginZkLoginNonce, proveZkLoginAddress } from "./zklogin-session";

const AUTH_ORIGIN = process.env.NEXT_PUBLIC_MYSOCIAL_AUTH_ORIGIN || "https://auth.testnet.mysocial.network";
const CLIENT_ID = process.env.NEXT_PUBLIC_MYSOCIAL_AUTH_CLIENT_ID || "mysocial-auth-client-id";
const CHANNEL = "mysocial-auth";

type AuthResult = {
    type?: string;
    state?: string;
    nonce?: string;
    access_token?: string;
    session_access_token?: string;
    expires_in?: number;
    error?: string;
    user?: { address?: string };
    id_token?: string;
};

/**
 * Open the hosted third-party login panel in a real popup.
 * `provider=none` shows that picker. `mode=popup` keeps the result in this
 * window instead of navigating it away. The blank window must open before
 * any await, or the browser treats the click as expired and blocks it.
 */
export async function signInWithMySocial(options?: { onAuthWindowClosed?: () => void }): Promise<string> {
    const popup = window.open("about:blank", "_blank", popupFeatures(420, 720));
    if (!popup) throw new Error("The sign-in window was blocked.");
    const state = randomToken();
    let nonce: string;
    try {
        nonce = await beginZkLoginNonce();
    } catch (error) {
        try { popup.close(); } catch { /* already closed */ }
        throw error;
    }
    const redirectUri = `${window.location.origin}/auth/callback`;
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        state,
        nonce,
        return_origin: window.location.origin,
        mode: "popup",
        provider: "none",
        code_challenge_method: "S256",
    });
    popup.location.href = `${AUTH_ORIGIN.replace(/\/$/, "")}/login?${params.toString()}`;
    try {
        const message = await waitForAuthResult(popup, state, nonce);
        try { popup.close(); } catch { /* The opener policy can block close. */ }
        if (message.type === "MYSOCIAL_AUTH_ERROR") throw new Error(message.error || "Sign-in failed.");
        if (message.nonce !== nonce || message.state !== state) throw new Error("Sign-in could not be verified.");
        const accessToken = message.session_access_token || message.access_token;
        if (!accessToken) throw new Error("Sign-in did not return an account token.");
        options?.onAuthWindowClosed?.();
        const zkToken = message.id_token && jwtNonce(message.id_token) === nonce ? message.id_token : undefined;
        const address = zkToken ? await proveZkLoginAddress(zkToken, accessToken) : walletFromAuth(message);
        if (!address) throw new Error(message.id_token ? "OAuth token nonce does not match zkLogin." : "Sign-in did not return a wallet address.");
        const response = await fetch("/api/myso/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken, expiresIn: message.expires_in, ...(message.id_token ? { idToken: message.id_token } : {}), ...(address ? { address } : {}) }),
        });
        const data = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(data.error || "MySo account connection could not finish");
        return accessToken;
    } catch (error) {
        try { popup.close(); } catch { /* already closed */ }
        throw error;
    }
}

function popupFeatures(width: number, height: number): string {
    const left = Math.round((window.screen.width - width) / 2);
    const top = Math.round((window.screen.height - height) / 2);
    return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

const walletPattern = /^0x[0-9a-fA-F]{1,64}$/;

function jwtNonce(token: string): string | undefined {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    try {
        const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
        const nonce = (JSON.parse(atob(padded)) as { nonce?: unknown }).nonce;
        return typeof nonce === "string" ? nonce : undefined;
    } catch {
        return undefined;
    }
}

function walletFromJwt(token: string | undefined): string | undefined {
    const payload = token?.split(".")[1];
    if (!payload) return undefined;
    try {
        const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
        const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
        for (const key of ["wallet_address", "address", "walletAddress"]) {
            const value = claims[key];
            if (typeof value === "string" && walletPattern.test(value.trim())) return value.trim();
        }
    } catch { /* not a JWT */ }
    return undefined;
}

function walletFromAuth(message: AuthResult): string | undefined {
    const direct = message.user?.address?.trim();
    if (direct && walletPattern.test(direct)) return direct;
    return walletFromJwt(message.session_access_token) || walletFromJwt(message.id_token) || walletFromJwt(message.access_token);
}

function randomToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function waitForAuthResult(popup: Window, state: string, nonce: string): Promise<AuthResult> {
    const authOrigin = new URL(AUTH_ORIGIN).origin;
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
    return new Promise((resolve, reject) => {
        const finish = (data: AuthResult) => {
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            channel?.removeEventListener("message", onBroadcast);
            channel?.close();
            resolve(data);
        };
        const timer = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            channel?.close();
            reject(new Error("Sign-in timed out."));
        }, 180_000);
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== authOrigin) return;
            const data = event.data as AuthResult;
            if (!data || (data.type !== "MYSOCIAL_AUTH_RESULT" && data.type !== "MYSOCIAL_AUTH_ERROR")) return;
            finish(data);
        };
        const onBroadcast = (event: MessageEvent) => {
            const data = event.data as AuthResult;
            if (!data || data.nonce !== nonce || data.state !== state) return;
            if (data.type !== "MYSOCIAL_AUTH_RESULT" && data.type !== "MYSOCIAL_AUTH_ERROR") return;
            finish(data);
        };
        window.addEventListener("message", onMessage);
        channel?.addEventListener("message", onBroadcast);
    });
}
