"use client";

import { useEffect, useState } from "react";

const CHANNEL = "mysocial-auth";

/** Relay the hosted sign-in popup back to the window that opened it. */
export default function AuthCallbackPage() {
    const [message, setMessage] = useState("Completing sign-in…");

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const hash = new URLSearchParams((window.location.hash || "").slice(1));
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
        const error = params.get("error");
        const state = params.get("state") || "";
        const nonce = params.get("nonce") || "";
        if (error) {
            channel?.postMessage({ type: "MYSOCIAL_AUTH_ERROR", error, state, nonce });
            setMessage(error);
        } else {
            const userParam = params.get("user");
            let user: { address?: string; sub?: string; email?: string } | undefined;
            if (userParam) {
                try { user = JSON.parse(decodeURIComponent(userParam)) as typeof user; } catch { user = undefined; }
            }
            const address = params.get("address") || undefined;
            const sub = params.get("sub") || undefined;
            const email = params.get("email") || undefined;
            if (address || sub || email) {
                user = { ...user, ...(address ? { address } : {}), ...(sub ? { sub } : {}), ...(email ? { email } : {}) };
            }
            channel?.postMessage({
                type: "MYSOCIAL_AUTH_RESULT",
                code: params.get("code") || undefined,
                state,
                nonce,
                id_token: hash.get("id_token") ?? params.get("id_token") ?? undefined,
                access_token: hash.get("access_token") ?? params.get("access_token") ?? undefined,
                session_access_token: hash.get("session_access_token") ?? params.get("session_access_token") ?? undefined,
                refresh_token: hash.get("refresh_token") ?? params.get("refresh_token") ?? undefined,
                expires_in: Number(hash.get("expires_in") ?? params.get("expires_in")) || undefined,
                user,
            });
        }
        const close = window.setTimeout(() => {
            channel?.close();
            window.close();
        }, 150);
        return () => window.clearTimeout(close);
    }, []);

    return <main className="myso-welcome"><p>{message}</p></main>;
}
