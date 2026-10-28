import type { MySoToolPort, ScopedTool } from "../../core/contracts/work.ts";

/** The configured agent service answered, but not with an MCP result. */
export class MySoAgentServiceError extends Error {
    constructor(readonly status: number) {
        super(`The agent service returned ${status}`);
    }
}

/** One authenticated principal per instance. Credentials must never be process-global in hosted mode. */
export class MySoMcpClient implements MySoToolPort {
    private readonly endpoint: URL;
    constructor(endpoint: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch, private readonly myDataSession?: string, private readonly boundAgentId?: string) {
        this.endpoint = new URL(endpoint);
        if (this.endpoint.username || this.endpoint.password || this.endpoint.hash || this.endpoint.search) throw new Error("MCP endpoint cannot contain credentials, query or fragment");
        if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname))) throw new Error("MCP endpoint requires HTTPS");
        if (!token || /[\r\n]/.test(token)) throw new Error("An authenticated MCP token is required");
        if (myDataSession !== undefined && (!/^[A-Za-z0-9+/]+={0,2}$/.test(myDataSession) || myDataSession.length > 32_768)) throw new Error("The MyData session is invalid or too large");
        if (boundAgentId !== undefined && !/^0x[0-9a-fA-F]{1,64}$/.test(boundAgentId)) throw new Error("The bound agent id is invalid");
    }
    private async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
        const id = crypto.randomUUID();
        const response = await this.fetcher(this.endpoint, {
            method: "POST", redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${this.token}`, "MCP-Protocol-Version": "2025-03-26",
                ...(this.boundAgentId ? { "x-myso-bound-agent": this.boundAgentId } : {}),
                ...(this.myDataSession && (method === "tools/list" || (method === "tools/call" && typeof (params as { name?: unknown }).name === "string" && (params as { name: string }).name.startsWith("work_run_"))) ? { "x-mydata-session": this.myDataSession } : {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === "tools/call" && (params as {name?: string}).name === "ai_chat" ? 240000 : 90000)]) : AbortSignal.timeout(method === "tools/call" && (params as {name?: string}).name === "ai_chat" ? 240000 : 90000),
        });
        if (!response.ok) {
            if (response.status === 404) throw new MySoAgentServiceError(response.status);
            throw new Error(`MCP request failed (${response.status}); reconcile paid actions before retrying`);
        }
        if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("MySo Agents requires the stateless JSON MCP transport");
        if (!response.body) throw new Error("MCP response is empty");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                if (size > 2 * 1024 * 1024) throw new Error("MCP response exceeds 2 MiB");
                chunks.push(next.value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        const merged = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        const envelope = JSON.parse(new TextDecoder().decode(merged)) as { id?: unknown; error?: unknown; result?: unknown };
        if (envelope.id !== id || envelope.error || envelope.result === undefined) throw new Error("MCP returned an invalid or rejected response");
        return envelope.result;
    }
    async listTools(): Promise<ScopedTool[]> {
        const tools: ScopedTool[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }>; nextCursor?: string };
            if (!Array.isArray(page.tools)) throw new Error("MCP tool catalog is invalid");
            for (const tool of page.tools) {
                if (!tool.name || !tool.inputSchema || seen.has(tool.name)) throw new Error("MCP tool catalog contains invalid or duplicate tools");
                seen.add(tool.name);
                tools.push({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true, idempotent: tool.annotations?.idempotentHint === true });
            }
            if (tools.length > 1000 || (page.nextCursor && page.nextCursor === cursor)) throw new Error("MCP tool catalog exceeded its pagination limit");
            cursor = page.nextCursor;
        } while (cursor);
        return tools;
    }
    async callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
        const result = await this.request("tools/call", { name, arguments: input }, signal) as { structuredContent?: { ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean; approvalRequired: boolean } }; isError?: boolean };
        if (!result.structuredContent || typeof result.structuredContent.ok !== "boolean") throw new Error("MySo MCP did not return a structured tool envelope");
        if (result.isError && result.structuredContent.ok) throw new Error("MCP response has conflicting success state");
        return result.structuredContent;
    }
}
