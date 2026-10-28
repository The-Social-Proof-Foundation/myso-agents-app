// @ts-check
"use strict";

/** @typedef {{value:string, expiresAt:number, custodyAccessToken?:string}} SessionGrant */
/** @typedef {{origin:string, secret:string, openExternal:(url:string)=>Promise<unknown>, installSession:(grant:SessionGrant,signal:AbortSignal)=>Promise<void>, clearSession:(value:string)=>Promise<void>, persistRefresh?:(refreshToken:string, expiresAt:number)=>void, fetchImpl?:typeof globalThis.fetch}} ConnectionOptions */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
/** @param {number} ms @param {AbortSignal} signal */
function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(new Error("Connection cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(undefined); }, ms);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
    });
}
/** @param {Response} response @returns {Promise<unknown>} */
async function limitedJson(response) {
    if (!response.body) throw new Error("Account service returned no response");
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
        for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 16384) throw new Error("Account response exceeded its limit"); chunks.push(item.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
}
/** The renderer can request connect/cancel only. URL, ticket, verifier and cookie
 * capabilities stay in the main process and its owned loopback server. After OAuth completes,
 * a short-lived access token is returned once for client-side custody derivation only.
 * @param {ConnectionOptions} options */
function createMySoDesktopConnection(options) {
    const origin = new URL(options.origin);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !/^[0-9a-f]{64}$/.test(options.secret)) throw new Error("MySo desktop sign-in requires the private loopback server");
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    /** @type {{controller:AbortController,ticket?:string}|undefined} */
    let active;
    /** @param {"start"|"result"|"cancel"} action @param {object} payload @param {AbortSignal} signal */
    async function post(action, payload, signal) {
        const response = await fetchImpl(new URL(`/api/myso/auth/desktop/${action}`, origin), {
            method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            headers: { "Content-Type": "application/json", "x-myso-agents-handoff": options.secret }, body: JSON.stringify(payload),
        });
        const result = await limitedJson(response);
        return { ok: response.ok, status: response.status, result: record(result) ? result : null };
    }
    /** @param {Record<string, unknown>} grant */
    function cookieGrant(grant) {
        if (typeof grant.value !== "string" || !/^[A-Za-z0-9_-]{40,3800}$/.test(grant.value) || typeof grant.expiresAt !== "number" || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 31 * 24 * 60 * 60 * 1000) return null;
        if (typeof grant.custodyAccessToken !== "string" || !/^[A-Za-z0-9._~+\/-]+=*$/.test(grant.custodyAccessToken) || grant.custodyAccessToken.length > 4096) return null;
        return { value: grant.value, expiresAt: grant.expiresAt, custodyAccessToken: grant.custodyAccessToken };
    }
    return {
        async connect() {
            if (active) return { connected: false, error: "An account connection is already pending" };
            const current = { controller: new AbortController(), ticket: /** @type {string|undefined} */ (undefined) };
            active = current;
            /** @type {SessionGrant|undefined} */
            let grant;
            try {
                const startedResponse = await post("start", {}, current.controller.signal);
                if (!startedResponse.ok || !startedResponse.result) throw new Error("MySo account connection could not finish; connect again");
                const started = startedResponse.result;
                if (typeof started.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(started.ticket) || typeof started.authorizationUrl !== "string" || typeof started.expiresAt !== "number" || !Number.isSafeInteger(started.expiresAt)) throw new Error("Invalid account connection reference");
                current.ticket = started.ticket;
                const destination = new URL(started.authorizationUrl);
                const local = ["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname);
                if (destination.username || destination.password || destination.hash || (destination.protocol !== "https:" && !(destination.protocol === "http:" && local))) throw new Error("Invalid account authorization destination");
                current.controller.signal.throwIfAborted();
                await options.openExternal(destination.toString());
                const deadline = Math.min(started.expiresAt, Date.now() + 10 * 60 * 1000);
                while (Date.now() < deadline) {
                    current.controller.signal.throwIfAborted();
                    const polled = await post("result", { ticket: current.ticket }, current.controller.signal);
                    if (!polled.ok || !polled.result) throw new Error("MySo account connection could not finish; connect again");
                    const result = polled.result;
                    if (result.status === "ready") {
                        if (!record(result.grant)) throw new Error("Invalid account session grant");
                        const session = cookieGrant(result.grant);
                        if (!session) throw new Error("Invalid account session grant");
                        const refreshToken = result.grant.refreshToken;
                        grant = session;
                        current.controller.signal.throwIfAborted();
                        await options.installSession(session, current.controller.signal);
                        current.controller.signal.throwIfAborted();
                        if (typeof refreshToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(refreshToken)) options.persistRefresh?.(refreshToken, session.expiresAt);
                        return { connected: true, custodyAccessToken: session.custodyAccessToken };
                    }
                    if (result.status !== "pending") throw new Error("Invalid account connection status");
                    await wait(750, current.controller.signal);
                }
                throw new Error("Account connection expired");
            } catch {
                // Compensate only this candidate cookie; never remove another completed connection.
                if (grant) await options.clearSession(grant.value).catch(() => {});
                return { connected: false, cancelled: current.controller.signal.aborted, error: current.controller.signal.aborted ? "Account connection cancelled" : "MySo account connection did not finish. Connect again when ready." };
            } finally {
                if (current.ticket) await post("cancel", { ticket: current.ticket }, AbortSignal.timeout(5000)).catch(() => {});
                if (active === current) active = undefined;
            }
        },
        async cancel() {
            const current = active;
            if (!current) return { cancelled: true };
            current.controller.abort();
            if (current.ticket) await post("cancel", { ticket: current.ticket }, AbortSignal.timeout(5000)).catch(() => {});
            return { cancelled: true };
        },
        /** Rotate the salt refresh token. The caller stores the replacement only after installSession resolves. */
        async renew(refreshToken) {
            if (typeof refreshToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return { status: "revoked" };
            let polled;
            try { polled = await post("refresh", { refreshToken }, AbortSignal.timeout(15000)); }
            catch { return { status: "retry" }; }
            if (polled.status === 401) return { status: "revoked" };
            if (!polled.ok || polled.status === 429 || !polled.result || !record(polled.result.grant) || typeof polled.result.refreshToken !== "string") return { status: "retry" };
            const session = cookieGrant(polled.result.grant);
            if (!session || !/^[A-Za-z0-9_-]{43}$/.test(polled.result.refreshToken)) return { status: "retry" };
            await options.installSession(session, AbortSignal.timeout(15000));
            return { status: "refreshed", refreshToken: polled.result.refreshToken, expiresAt: session.expiresAt };
        },
        async logout(refreshToken) {
            if (typeof refreshToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return { ok: false };
            const polled = await post("logout", { refreshToken }, AbortSignal.timeout(15000));
            return { ok: polled.ok };
        },
    };
}
module.exports = { createMySoDesktopConnection };
