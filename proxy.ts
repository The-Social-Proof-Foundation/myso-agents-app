import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
    // These handlers verify their own live MCP account/signer binding. The auth flow uses
    // PKCE/state; cookie-authenticated writes additionally require the configured app origin.
    // zkLogin clock, salt, prove, and address are the hosted browser sign-in, not the desktop local API.
    if (request.nextUrl.pathname.startsWith("/api/myso/") || request.nextUrl.pathname.startsWith("/api/zklogin/")) return NextResponse.next();
	if (process.env.MYSO_AGENTS_ENABLE_LEGACY_LOCAL_API !== "1" || !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Legacy local API access requires the trusted MySo Agents desktop window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/chat/:path*", "/settings/:path*"] };
