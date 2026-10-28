import { NextResponse } from "next/server";
import { zkLoginSaltOrigin } from "@/src/server/zklogin-service";

async function forward(request: Request): Promise<NextResponse> {
    const authorization = request.headers.get("authorization");
    if (!authorization) return NextResponse.json({ error: "Bearer token required" }, { status: 401 });
    const response = await fetch(`${zkLoginSaltOrigin()}/zklogin-salt`, {
        method: request.method,
        headers: { authorization, "content-type": "application/json" },
        body: request.method === "GET" ? undefined : await request.text(),
        cache: "no-store",
    });
    return new NextResponse(await response.text(), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
}

export function GET(request: Request) {
    return forward(request);
}

export function PUT(request: Request) {
    return forward(request);
}
