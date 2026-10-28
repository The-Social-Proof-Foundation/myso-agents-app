import { z } from "zod";
import type { MySoToolPort, ScopedTool } from "../../core/contracts/work.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const credentialPattern = /^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i;
const delegatePattern = /^delegate:[A-Za-z0-9._-]{1,64}$/;
const objectIdPattern = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * MySo MCP client for the durable harness worker. It sends the per-run bearer
 * and identity binding to the private automation sidecar; the sidecar opens
 * the selected action-worker key and supplies its MyData session to hosted
 * MCP. The runner never receives either the delegate seed or MyData session,
 * and it never stores or forwards the owner's OAuth bearer.
 */
export class MySoRunWorkerMcpClient implements MySoToolPort {
    private readonly endpoint: URL;
    private readonly fetcher: typeof fetch;

    constructor(
        sidecarUrl: string,
        private readonly internalSecret: string,
        private readonly binding: {
            keyRef: string;
            accountId: string;
            parentAgentId: string;
            workerAgentId: string;
            runId: string;
            credential: string;
        },
        fetcher: typeof fetch = fetch,
    ) {
        this.endpoint = new URL("/internal/work/mcp", sidecarUrl);
        if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname))) {
            throw new Error("The run-worker sidecar must use HTTPS, except for loopback development");
        }
        if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error("The run-worker sidecar URL cannot contain credentials, query or fragment");
        if (!internalSecret || /[\r\n]/.test(internalSecret)) throw new Error("The run-worker sidecar secret is invalid");
        if (!delegatePattern.test(binding.keyRef) || !objectIdPattern.test(binding.accountId)
            || !objectIdPattern.test(binding.parentAgentId) || !objectIdPattern.test(binding.workerAgentId)
            || !z.uuid().safeParse(binding.runId).success || !credentialPattern.test(binding.credential)) {
            throw new Error("The run-worker identity binding is invalid");
        }
        this.fetcher = fetcher;
    }

    private async request(method: "tools/list" | "tools/call", params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        const id = crypto.randomUUID();
        const response = await this.fetcher(this.endpoint, {
            method: "POST",
            redirect: "error",
            cache: "no-store",
            headers: { "content-type": "application/json", accept: "application/json", "x-internal-sync-secret": this.internalSecret },
            body: JSON.stringify({
                key_ref: this.binding.keyRef,
                account_id: this.binding.accountId,
                parent_agent_id: this.binding.parentAgentId,
                worker_agent_id: this.binding.workerAgentId,
                run_id: this.binding.runId,
                credential: this.binding.credential,
                request: { jsonrpc: "2.0", id, method, params },
            }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        });
        if (!response.ok) throw new Error(`Run-worker MCP request failed (${response.status})`);
        if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Run-worker MCP returned a non-JSON response");
        const raw = await response.text();
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error("Run-worker MCP response exceeds 2 MiB");
        const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: z.unknown().optional() }).strict().parse(JSON.parse(raw));
        if (envelope.id !== id || envelope.error !== undefined || envelope.result === undefined) throw new Error("Run-worker MCP returned an invalid or rejected response");
        return envelope.result;
    }

    async listTools(): Promise<ScopedTool[]> {
        const tools: ScopedTool[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let pageNo = 0; pageNo < 20; pageNo++) {
            const page = z.object({
                tools: z.array(z.object({
                    name: z.string().min(1).max(128), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()),
                    annotations: z.object({ readOnlyHint: z.boolean().optional(), idempotentHint: z.boolean().optional() }).optional(),
                }).passthrough()).max(1000), nextCursor: z.string().min(1).optional(),
            }).passthrough().parse(await this.request("tools/list", cursor ? { cursor } : {}));
            for (const tool of page.tools) {
                if (seen.has(tool.name)) throw new Error("Run-worker MCP catalog contains duplicate tool names");
                seen.add(tool.name);
                tools.push({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true, idempotent: tool.annotations?.idempotentHint === true });
            }
            if (!page.nextCursor) return tools;
            if (page.nextCursor === cursor) throw new Error("Run-worker MCP cursor did not advance");
            cursor = page.nextCursor;
        }
        throw new Error("Run-worker MCP catalog exceeds its pagination limit");
    }

    async callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
        const result = z.object({ structuredContent: z.object({
            ok: z.boolean(), data: z.unknown().optional(),
            error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), approvalRequired: z.boolean() }).optional(),
        }).optional(), isError: z.boolean().optional() }).passthrough().parse(await this.request("tools/call", { name, arguments: input }, signal));
        if (!result.structuredContent) throw new Error("Run-worker MCP omitted its structured tool result");
        return result.structuredContent;
    }
}
