import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { executionScopeSchema, type ExecutionScope } from "../core/contracts/work.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { MySoAgentServiceError, MySoMcpClient } from "./integrations/myso-mcp.ts";
import { MySoRunWorkerMcpClient } from "./integrations/myso-run-worker-mcp.ts";

const SESSION = "myso_agents_session";
const FLOW = "myso_agents_connect";
const tokenPattern = /^[A-Za-z0-9._~+\/-]+=*$/;
export class MySoAccessError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
function url(value: string | undefined, label: string): URL {
    if (!value) throw new MySoAccessError(503, `${label} is not configured`);
    const parsed = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))) throw new MySoAccessError(503, `${label} must use HTTPS or a loopback development URL`);
    return parsed;
}
function origin(): URL {
    const value = url(process.env.MYSO_AGENTS_PUBLIC_ORIGIN, "MySo Agents public origin");
    if (value.pathname !== "/") throw new MySoAccessError(503, "The public origin must not contain a path");
    return value;
}
function secret(): Buffer {
    const encoded = process.env.MYSO_AGENTS_SESSION_KEY;
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new MySoAccessError(503, "A 32-byte base64 session encryption key must be configured");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) throw new MySoAccessError(503, "Invalid session encryption key");
    return key;
}
function seal(name: string, value: object): string {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", secret(), nonce);
    cipher.setAAD(Buffer.from(`${name}|${origin().origin}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const result = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    if (result.length > 3800) throw new MySoAccessError(503, "The authorization token exceeds the supported encrypted session size");
    return result;
}
function open(name: string, value: string): unknown {
    try {
        if (value.length > 3800) throw new Error();
        const bytes = Buffer.from(value, "base64url");
        const cipher = createDecipheriv("aes-256-gcm", secret(), bytes.subarray(0,12));
        cipher.setAAD(Buffer.from(`${name}|${origin().origin}`)); cipher.setAuthTag(bytes.subarray(12,28));
        return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
    } catch { throw new MySoAccessError(401, "Reconnect your MySo account"); }
}
function cookie(req: Request, name: string): string | undefined {
    const entries = (req.headers.get("cookie") ?? "").split(";").map((item) => item.trim().split("="));
    const matches = entries.filter(([key]) => key === name);
    if (matches.length > 1) throw new MySoAccessError(401, "Invalid account session");
    return matches[0]?.slice(1).join("=");
}
function setCookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}${origin().protocol === "https:" ? "; Secure" : ""}`;
}
export function assertMySoRequestOrigin(req: Request): void {
    const supplied = req.headers.get("origin");
    if (supplied !== origin().origin) throw new MySoAccessError(403, "This action must come from your MySo Agents window");
}
async function limitedJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.body) throw new MySoAccessError(502, "MySo authorization service is unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
    try { for (;;) { const part=await reader.read(); if(part.done)break; size+=part.value.byteLength; if(size>64*1024)throw new Error(); chunks.push(part.value); } }
    catch { throw new MySoAccessError(502,"MySo authorization returned an invalid response"); }
    finally { await reader.cancel().catch(()=>{}); }
    const bytes=new Uint8Array(size);let index=0;for(const chunk of chunks){bytes.set(chunk,index);index+=chunk.byteLength;}
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MySoAccessError(502,"MySo authorization returned an invalid response"); }
}
const metadataSchema=z.object({ issuer:z.string(),authorization_endpoint:z.string(),token_endpoint:z.string(),code_challenge_methods_supported:z.array(z.string()) });
export async function mySoAuthorizationConfig() {
    const issuer=url(process.env.MYSO_AGENTS_OAUTH_ISSUER,"MySo authorization issuer");
    const clientId=process.env.MYSO_AGENTS_OAUTH_CLIENT_ID;
    const scopes=(process.env.MYSO_AGENTS_OAUTH_SCOPES ?? "").split(/\s+/).filter(Boolean);
    if(!clientId || !scopes.includes("mcp:connect") || !scopes.includes("agent:read"))throw new MySoAccessError(503,"MySo OAuth client and approved scopes are not configured");
    // OAuth Authorization Server Metadata (RFC 8414), including path-based issuers.
    const discovery=new URL(`/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/,"")}`,issuer.origin);
    const metadata=metadataSchema.parse(await limitedJson(await fetch(discovery,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10000)})));
    if(metadata.issuer.replace(/\/$/,"")!==issuer.toString().replace(/\/$/,"") || !metadata.code_challenge_methods_supported.includes("S256"))throw new MySoAccessError(503,"Authorization issuer or PKCE support does not match configuration");
    return {clientId,scopes,resource:url(process.env.MYSO_AGENTS_MCP_URL,"MySo MCP endpoint").toString(),authorize:url(metadata.authorization_endpoint,"Authorization endpoint"),token:url(metadata.token_endpoint,"Token endpoint"),issuer:metadata.issuer,redirect:new URL("/api/myso/auth/callback",origin()).toString()};
}
export type MySoAuthorization = Awaited<ReturnType<typeof mySoAuthorizationConfig>>;
export async function beginMySoAuthorization(state = randomBytes(32).toString("base64url")) {
    const config = await mySoAuthorizationConfig();
    const verifier = randomBytes(48).toString("base64url");
    const destination = new URL(config.authorize);
    destination.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirect, scope: config.scopes.join(" "), state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: config.resource }).toString();
    return { config, verifier, state, destination: destination.toString() };
}
export async function exchangeMySoAuthorization(config: MySoAuthorization, verifier: string, code: string) {
    if (config.resource !== url(process.env.MYSO_AGENTS_MCP_URL,"MySo MCP endpoint").toString()) throw new MySoAccessError(401,"The account connection configuration changed; connect again");
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, code_verifier: verifier, redirect_uri: config.redirect, resource: config.resource });
    const tokens = tokenSchema.parse(await limitedJson(await fetch(config.token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form,redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10000)})));
    if(tokens.token_type.toLowerCase()!=="bearer")throw new MySoAccessError(502,"Unsupported authorization token type");
    await mySoContextForToken(tokens.access_token);
    return { token: tokens.access_token, expiresAt: Date.now() + Math.min(tokens.expires_in,30*24*60*60)*1000 };
}
export function mySoSessionCookie(session: { token: string; expiresAt: number; owner?: string; agentId?: string }): string { return seal(SESSION, session); }
const walletAddress = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const hostedSessionSchema = z.object({
    accessToken: z.string().regex(tokenPattern),
    expiresIn: z.number().int().positive().max(30 * 24 * 60 * 60).optional(),
    address: walletAddress.optional(),
    idToken: z.string().regex(tokenPattern).optional(),
});
function walletFromToken(token: string): string | undefined {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { wallet_address?: unknown; address?: unknown };
        const value = claims.wallet_address ?? claims.address;
        return typeof value === "string" && walletAddress.safeParse(value).success ? value : undefined;
    } catch { return undefined; }
}
/** Store the MySocial sign-in token. Agent features still need MCP; the account itself does not. */
export async function establishMySoSession(req: Request): Promise<Response> {
    try {
        assertMySoRequestOrigin(req);
        let body: unknown;
        try { body = await req.json(); } catch { throw new MySoAccessError(400, "The sign-in result could not be read"); }
        const parsed = hostedSessionSchema.safeParse(body);
        if (!parsed.success) throw new MySoAccessError(400, "The sign-in result could not be used");
        const expiresAt = Date.now() + (parsed.data.expiresIn ?? 60 * 60) * 1000;
        const owner = parsed.data.address ?? walletFromToken(parsed.data.accessToken) ?? (parsed.data.idToken ? walletFromToken(parsed.data.idToken) : undefined);
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": setCookie(SESSION, mySoSessionCookie({ token: parsed.data.accessToken, expiresAt, ...(owner ? { owner } : {}) }), (expiresAt - Date.now()) / 1000) } });
    } catch (error) { return mySoErrorResponse(error); }
}
const flowSchema=z.object({state:z.string(),verifier:z.string(),expiresAt:z.number(),issuer:z.string()});
const sessionSchema=z.object({token:z.string().regex(tokenPattern),expiresAt:z.number(),owner:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),agentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional()});
const tokenSchema=z.object({access_token:z.string().regex(tokenPattern),token_type:z.string(),expires_in:z.number().int().positive(),scope:z.string().optional()});
function equal(a:string,b:string):boolean {const left=Buffer.from(a);const right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
export async function handleMySoAuth(req:Request,action:"start"|"callback"|"logout"):Promise<Response>{
    try {
        if(action==="logout"){
            assertMySoRequestOrigin(req);
            return Response.json({ok:true},{headers:{"Set-Cookie":setCookie(SESSION,"",0),"Cache-Control":"no-store"}});
        }
        if(action==="start"){
            const authorization=await beginMySoAuthorization();
            return new Response(null,{status:303,headers:{Location:authorization.destination,"Cache-Control":"no-store","Referrer-Policy":"no-referrer","Set-Cookie":setCookie(FLOW,seal(FLOW,{state:authorization.state,verifier:authorization.verifier,expiresAt:Date.now()+10*60*1000,issuer:authorization.config.issuer}),600)}});
        }
        const config=await mySoAuthorizationConfig();
        const query=new URL(req.url).searchParams;
        const saved=cookie(req,FLOW);if(!saved)throw new MySoAccessError(401,"The account connection expired; connect again");
        const flow=flowSchema.parse(open(FLOW,saved));
        if(flow.expiresAt<=Date.now() || flow.issuer!==config.issuer || !equal(flow.state,query.get("state")??"") || (query.has("iss")&&query.get("iss")!==config.issuer))throw new MySoAccessError(401,"The account connection could not be verified");
        const code=query.get("code");if(query.has("error") || !code || code.length>4096)throw new MySoAccessError(401,"MySo account connection was not completed");
        const session = await exchangeMySoAuthorization(config,flow.verifier,code);
        const headers=new Headers({Location:"/","Cache-Control":"no-store"});
        headers.append("Set-Cookie",setCookie(SESSION,mySoSessionCookie(session),(session.expiresAt-Date.now())/1000));
        headers.append("Set-Cookie",setCookie(FLOW,"",0));
        return new Response(null,{status:303,headers});
    }catch(error){return mySoErrorResponse(error);}
}
const contextSchema=z.object({
    owner:z.string(),memoryAccountId:z.string(),agentObjectId:z.string(),derivedAddress:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),organizationId:z.string().nullable(),platformId:z.string().nullable(),network:z.string(),rpcUrl:z.string().url(),label:z.string(),
    socialChain:z.object({packageId:z.string(),memoryConfigId:z.string(),clockId:z.string().optional()}).passthrough(),
    chain:z.object({authenticated:z.literal(true)}),expiresAtMs:z.number().nullable(),permittedRegistryActions:z.array(z.string()),
});
export function readMySoBrowserSession(req: Request): { token: string; expiresAt: number; owner?: string; agentId?: string } {
    const value=cookie(req,SESSION);if(!value)throw new MySoAccessError(401,"Connect your MySo account to continue");
    const session=sessionSchema.parse(open(SESSION,value));if(session.expiresAt<=Date.now())throw new MySoAccessError(401,"Reconnect your MySo account");
    return session;
}
async function mySoContextForToken(token:string,myDataSession?:string,boundAgentId?:string){
    const mcp=new MySoMcpClient(url(process.env.MYSO_AGENTS_MCP_URL,"MySo MCP endpoint").toString(),token,fetch,myDataSession,boundAgentId);
    const result=await mcp.callTool("agent_get_context",{});
    if(!result.ok)throw new MySoAccessError(401,"MySo account authorization is unavailable; reconnect your account");
    const data=contextSchema.parse(result.data);
    if(data.expiresAtMs!==null && data.expiresAtMs<=Date.now())throw new MySoAccessError(401,"Your agent authorization has expired");
    const scope:ExecutionScope=executionScopeSchema.parse({network:data.network,owner:data.owner,accountId:data.memoryAccountId,agentId:data.agentObjectId,organizationId:data.organizationId??undefined,platformId:data.platformId??undefined});
    return {mcp,scope,label:data.label,derivedAddress:data.derivedAddress,rpcUrl:data.rpcUrl,socialChain:data.socialChain,permittedActions:data.permittedRegistryActions};
}
export async function authenticatedMySoRunWorker(binding:{keyRef:string;accountId:string;parentAgentId:string;workerAgentId:string;runId:string;credential:string}){
    const sidecarUrl=process.env.MYSO_AGENTS_AUTOMATION_SIDECAR_URL;
    const internalSecret=process.env.MYSO_AGENTS_AUTOMATION_INTERNAL_SECRET;
    if(!sidecarUrl||!internalSecret)throw new MySoAccessError(503,"The durable run-worker bridge is not configured");
    const mcp=new MySoRunWorkerMcpClient(sidecarUrl,internalSecret,binding);
    const result=await mcp.callTool("agent_get_context",{});
    if(!result.ok)throw new MySoAccessError(401,"The action-worker run credential is unavailable");
    const data=contextSchema.parse(result.data);
    const scope=executionScopeSchema.parse({network:data.network,owner:data.owner,accountId:data.memoryAccountId,agentId:data.agentObjectId,organizationId:data.organizationId??undefined,platformId:data.platformId??undefined});
    const canonical=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
    if(canonical(scope.accountId)!==canonical(binding.accountId)||canonical(scope.agentId)!==canonical(binding.parentAgentId))
        throw new MySoAccessError(403,"The worker credential context does not match the queued parent and account");
    return {mcp,scope,label:data.label,derivedAddress:data.derivedAddress,rpcUrl:data.rpcUrl,socialChain:data.socialChain,permittedActions:data.permittedRegistryActions};
}
export async function authenticatedMySo(req:Request){
    if(process.env.MYSO_AGENTS_DESKTOP_SERVER === "1" && !desktopAPIAuthorized(req.headers)) throw new MySoAccessError(403,"Open this workspace in the trusted MySo Agents desktop window");
    const authorization=req.headers.get("authorization");
    let token:string;
    let boundAgentId:string|undefined;
    if(authorization){
        const match=/^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(authorization);if(!match)throw new MySoAccessError(401,"Invalid MySo authorization");token=match[1]!;
        if(req.headers.has("origin"))assertMySoRequestOrigin(req);
    }else{
        const value=cookie(req,SESSION);if(!value)throw new MySoAccessError(401,"Connect your MySo account to continue");
        const session=sessionSchema.parse(open(SESSION,value));if(session.expiresAt<=Date.now())throw new MySoAccessError(401,"Reconnect your MySo account");
        if(!["GET","HEAD"].includes(req.method))assertMySoRequestOrigin(req);
        token=session.token;
        boundAgentId=session.agentId;
    }
    const myDataSession=req.headers.get("x-mydata-session")??undefined;
    if(myDataSession!==undefined && (!/^[A-Za-z0-9+/]+={0,2}$/.test(myDataSession)||myDataSession.length>32_768))throw new MySoAccessError(400,"The short-lived MyData session is invalid");
    return mySoContextForToken(token,myDataSession,boundAgentId);
}
export async function selectMySoBoundAgent(req: Request, agentObjectId: string | null): Promise<Response> {
    const value=cookie(req,SESSION);if(!value)throw new MySoAccessError(401,"Connect your MySo account to continue");
    const session=sessionSchema.parse(open(SESSION,value));if(session.expiresAt<=Date.now())throw new MySoAccessError(401,"Reconnect your MySo account");
    if(!["GET","HEAD"].includes(req.method))assertMySoRequestOrigin(req);
    const bound=agentObjectId??undefined;
    const context=await mySoContextForToken(session.token,undefined,bound);
    const canonical=(id:string)=>id.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
    if(bound && canonical(context.scope.agentId)!==canonical(bound))throw new MySoAccessError(403,"The selected agent is not available for this wallet");
    const next={token:session.token,expiresAt:session.expiresAt,...(session.owner?{owner:session.owner}:{}),...(bound?{agentId:context.scope.agentId}:{})};
    return Response.json({ok:true,agentId:context.scope.agentId},{headers:{"Cache-Control":"no-store","Set-Cookie":setCookie(SESSION,mySoSessionCookie(next),(session.expiresAt-Date.now())/1000)}});
}
export function mySoErrorResponse(error:unknown):Response{
    const message=error instanceof MySoAccessError||error instanceof MySoAgentServiceError?error.message:"MySo Agents could not complete this request";
    const status=error instanceof MySoAccessError?error.status:502;
    return Response.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
}
