/** Main-process-only OAuth handoff records. These are ephemeral login handshakes,
 * never authoritative task state. They cannot be used on a hosted deployment. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MySoAccessError, assertMySoRequestOrigin, beginMySoAuthorization, exchangeMySoAuthorization, mySoErrorResponse, mySoSessionCookie, type MySoAuthorization } from "./myso-auth.ts";

interface SessionGrant {
    value: string;
    expiresAt: number;
    custodyAccessToken: string;
    refreshToken?: string;
}
interface DesktopFlow {
    ticket: string;
    state: string;
    verifier: string;
    config: MySoAuthorization;
    expiresAt: number;
    status: "pending" | "exchanging" | "ready" | "failed";
    grant?: SessionGrant;
}
const storageKey = Symbol.for("myso-agents.desktop-oauth-flows");
const shared = globalThis as typeof globalThis & { [storageKey]?: Map<string, DesktopFlow> };
function flows(): Map<string, DesktopFlow> {
    // Next route bundles can have distinct module instances in the same owned server process.
    return shared[storageKey] ??= new Map<string, DesktopFlow>();
}
function clean(): void {
    for (const [ticket, flow] of flows()) if (flow.expiresAt <= Date.now()) flows().delete(ticket);
}
function requireMainProcess(req: Request): void {
    const expected = process.env.MYSO_AGENTS_DESKTOP_HANDOFF_SECRET;
    const supplied = req.headers.get("x-myso-agents-handoff") ?? "";
    // This secret is separate from the header auto-injected into renderer API requests.
    // The cookie grant stays in main; a one-time access-token handoff is returned only for
    // local custody derivation and is never persisted by the renderer.
    if (process.env.MYSO_AGENTS_DESKTOP_SERVER !== "1" || !expected || !/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw new MySoAccessError(403, "This account handoff is available only to the owned desktop process");
    }
}
const ticketSchema = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const tokenPattern = /^[A-Za-z0-9._~+\/-]+=*$/;
const refreshPattern = /^[A-Za-z0-9_-]{43}$/;
const walletAddress = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const hashTokensSchema = z.object({
    state: z.string().regex(/^desktop\.[A-Za-z0-9_-]{43}$/),
    sessionAccessToken: z.string().regex(tokenPattern).max(4096),
    refreshToken: z.string().regex(refreshPattern),
    expiresIn: z.number().int().positive().max(30 * 24 * 60 * 60),
    address: walletAddress.optional(),
}).strict();
const codeSchema = z.object({
    state: z.string().regex(/^desktop\.[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(4096),
}).strict();
const refreshSchema = z.object({ refreshToken: z.string().regex(refreshPattern) }).strict();
async function readJson(req: Request, limit: number): Promise<unknown> {
    if (!req.headers.get("content-type")?.includes("application/json") || !req.body) throw new MySoAccessError(400, "Invalid desktop handoff request");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw new MySoAccessError(413, "Desktop handoff request is too large"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new MySoAccessError(400, "Invalid desktop handoff request"); }
}
async function readTicket(req: Request): Promise<string> {
    if (!req.headers.get("content-type")?.includes("application/json") || !req.body) throw new MySoAccessError(400, "Invalid desktop handoff request");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024) throw new MySoAccessError(413, "Desktop handoff request is too large"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return ticketSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).ticket; }
    catch { throw new MySoAccessError(400, "Invalid desktop handoff reference"); }
}
export async function handleDesktopMySoAuth(req: Request, action: "start" | "result" | "cancel"): Promise<Response> {
    try {
        requireMainProcess(req); clean();
        if (action === "start") {
            if (flows().size >= 8) throw new MySoAccessError(429, "Finish or cancel the existing account connection first");
            const ticket = randomBytes(32).toString("base64url");
            const state = `desktop.${randomBytes(32).toString("base64url")}`;
            const authorization = await beginMySoAuthorization(state);
            // Do not let a concurrent metadata request exceed the bounded handoff inventory.
            clean(); if (flows().size >= 8) throw new MySoAccessError(429, "An account connection is already pending");
            const expiresAt = Date.now() + 10 * 60 * 1000;
            flows().set(ticket, { ticket, state, verifier: authorization.verifier, config: authorization.config, expiresAt, status: "pending" });
            return Response.json({ ticket, authorizationUrl: authorization.destination, expiresAt }, { headers: { "Cache-Control": "no-store" } });
        }
        const ticket = await readTicket(req);
        const flow = flows().get(ticket);
        if (action === "cancel") { flows().delete(ticket); return Response.json({ cancelled: true }, { headers: { "Cache-Control": "no-store" } }); }
        if (!flow) throw new MySoAccessError(410, "The account connection expired or was cancelled");
        if (flow.status === "failed") { flows().delete(ticket); throw new MySoAccessError(401, "MySo account connection was not completed"); }
        if (flow.status !== "ready" || !flow.grant) return Response.json({ status: "pending" }, { status: 202, headers: { "Cache-Control": "no-store" } });
        // One main-process delivery. A lost response requires another login, never a token/URL bridge.
        flows().delete(ticket);
        return Response.json({ status: "ready", grant: flow.grant }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return mySoErrorResponse(error); }
}
function browserResult(connected: boolean): Response {
    const title = connected ? "MySo account connected" : "MySo connection not completed";
    const message = connected ? "Return to MySo Agents. You can close this browser tab." : "Return to MySo Agents and connect again when you are ready.";
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`, { status: connected ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff" } });
}
function tokenCapturePage(state: string): Response {
    const nonce = randomBytes(16).toString("base64url");
    const script = `const params=new URLSearchParams(location.search);const hash=new URLSearchParams((location.hash||"").slice(1));const sessionAccessToken=hash.get("session_access_token")||hash.get("access_token")||"";const refreshToken=hash.get("refresh_token")||"";const expiresIn=Number(hash.get("expires_in"));const address=params.get("address")||"";const state=${JSON.stringify(state)};history.replaceState(null,"",location.pathname+location.search);const body=sessionAccessToken&&refreshToken&&expiresIn>0?{state,sessionAccessToken,refreshToken,expiresIn,...(address?{address}:{})}:{state,code:params.get("code")||""};fetch("/api/myso/auth/desktop/tokens",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>{const ok=response.ok;document.querySelector("h1").textContent=ok?"MySo account connected":"MySo connection not completed";document.querySelector("p").textContent=ok?"Return to MySo Agents. You can close this browser tab.":"Return to MySo Agents and connect again when you are ready."}).catch(()=>{document.querySelector("h1").textContent="MySo connection not completed";document.querySelector("p").textContent="Return to MySo Agents and connect again when you are ready."});`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Completing MySo sign-in</title></head><body><main><h1>Completing MySo sign-in</h1><p>Return to MySo Agents when this page finishes.</p></main><script nonce="${nonce}">${script}</script></body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, "X-Content-Type-Options": "nosniff" } });
}
function claimPending(state: string): DesktopFlow {
    clean();
    if (process.env.MYSO_AGENTS_DESKTOP_SERVER !== "1") throw new MySoAccessError(403, "This account handoff is available only to the owned desktop process");
    const flow = [...flows().values()].find((candidate) => candidate.state === state);
    if (!flow || flow.expiresAt <= Date.now()) throw new MySoAccessError(410, "The account connection expired or was cancelled");
    if (flow.status !== "pending") throw new MySoAccessError(409, "The account connection was already completed");
    flow.status = "exchanging";
    return flow;
}
function finishGrant(flow: DesktopFlow, grant: SessionGrant): void {
    if (flows().get(flow.ticket) !== flow || flow.expiresAt <= Date.now()) throw new MySoAccessError(410, "The account connection expired or was cancelled");
    flow.grant = grant;
    flow.status = "ready";
    flow.expiresAt = Math.min(grant.expiresAt, Date.now() + 120000);
    flow.verifier = "";
}
/** System-browser callback. The hash never reaches this request, so the page posts
 * the session tokens once. The refresh token is not written into the page. */
export async function completeDesktopMySoAuth(req: Request): Promise<Response> {
    clean();
    if (process.env.MYSO_AGENTS_DESKTOP_SERVER !== "1") return browserResult(false);
    const query = new URL(req.url).searchParams;
    const state = query.get("state") ?? "";
    const flow = [...flows().values()].find((candidate) => candidate.state === state);
    if (!flow || flow.expiresAt <= Date.now() || query.has("error") || (query.has("iss") && query.get("iss") !== flow.config.issuer)) return browserResult(false);
    if (flow.status === "ready") return browserResult(true);
    if (flow.status !== "pending") return browserResult(false);
    return tokenCapturePage(state);
}
/** Browser-only completion of the callback page. Main later collects the grant with the handoff secret. */
export async function acceptDesktopSessionTokens(req: Request): Promise<Response> {
    let flow: DesktopFlow | undefined;
    try {
        assertMySoRequestOrigin(req);
        const body = await readJson(req, 16384);
        const hash = hashTokensSchema.safeParse(body);
        const code = codeSchema.safeParse(body);
        if (!hash.success && !code.success) throw new MySoAccessError(400, "The sign-in result could not be used");
        flow = claimPending((hash.success ? hash.data.state : code.data!.state));
        if (hash.success) {
            const expiresAt = Date.now() + hash.data.expiresIn * 1000;
            const session = { token: hash.data.sessionAccessToken, expiresAt, ...(hash.data.address ? { owner: hash.data.address } : {}) };
            finishGrant(flow, { value: mySoSessionCookie(session), expiresAt, custodyAccessToken: session.token, refreshToken: hash.data.refreshToken });
        } else {
            const session = await exchangeMySoAuthorization(flow.config, flow.verifier, code.data!.code);
            finishGrant(flow, { value: mySoSessionCookie(session), expiresAt: session.expiresAt, custodyAccessToken: session.token });
        }
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        if (flow && flows().get(flow.ticket) === flow && flow.status === "exchanging") { flow.status = "failed"; flow.grant = undefined; flow.verifier = ""; }
        return mySoErrorResponse(error);
    }
}
function saltOrigin(): URL {
    const configured = process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL ?? "https://salt.testnet.mysocial.network";
    let parsed: URL;
    try { parsed = new URL(configured); } catch { throw new MySoAccessError(503, "The MySo session service is not configured"); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== "https:" || parsed.pathname !== "/") throw new MySoAccessError(503, "The MySo session service is not configured");
    return parsed;
}
async function saltJson(path: string, refreshToken: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(new URL(path, saltOrigin()), { method: "POST", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(10000) });
    if (response.status === 204) return { status: 204, body: null };
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: null };
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16384) return { status: 502, body: null }; chunks.push(part.value); }
    } catch { return { status: 502, body: null }; }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) }; }
    catch { return { status: response.status, body: null }; }
}
const refreshedSchema = z.object({
    access_token: z.string().regex(tokenPattern).max(4096).optional(),
    session_access_token: z.string().regex(tokenPattern).max(4096),
    refresh_token: z.string().regex(refreshPattern),
    expires_in: z.number().int().positive().max(30 * 24 * 60 * 60),
    user: z.object({ address: z.string().optional() }).passthrough().optional(),
}).strict();
let refreshQueue: Promise<void> = Promise.resolve();
function enqueueRefresh<T>(work: () => Promise<T>): Promise<T> {
    const run = refreshQueue.then(work, work);
    refreshQueue = run.then(() => undefined, () => undefined);
    return run;
}
/** Main-process renewal. One salt rotation at a time; the previous refresh token is not returned. */
export async function refreshDesktopMySoSession(req: Request): Promise<Response> {
    try {
        requireMainProcess(req);
        const body = refreshSchema.parse(await readJson(req, 1024));
        const outcome = await enqueueRefresh(() => saltJson("/auth/refresh", body.refreshToken));
        if (outcome.status === 401) throw new MySoAccessError(401, "Reconnect your MySo account");
        if (outcome.status === 429) throw new MySoAccessError(429, "MySo session renewal is busy; the current sign-in remains");
        const parsed = refreshedSchema.safeParse(outcome.body);
        if (outcome.status !== 200 || !parsed.success) throw new MySoAccessError(502, "MySo session renewal is unavailable");
        const access = parsed.data.session_access_token;
        const expiresAt = Date.now() + parsed.data.expires_in * 1000;
        const address = parsed.data.user?.address;
        const owner = address && walletAddress.safeParse(address).success ? address : undefined;
        const grant = { value: mySoSessionCookie({ token: access, expiresAt, ...(owner ? { owner } : {}) }), expiresAt, custodyAccessToken: access };
        return Response.json({ grant, refreshToken: parsed.data.refresh_token }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return mySoErrorResponse(error); }
}
/** Main-process logout. Local deletion still happens when the salt call fails. */
export async function logoutDesktopMySoSession(req: Request): Promise<Response> {
    try {
        requireMainProcess(req);
        const body = refreshSchema.parse(await readJson(req, 1024));
        await saltJson("/auth/logout", body.refreshToken).catch(() => undefined);
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return mySoErrorResponse(error); }
}
