import { createHash } from "node:crypto";
import { z } from "zod";
import type { AssistantMessage, JsonObject, Model, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { collapseSystemMessages, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { decimalMistSchema, type ExecutionScope, type MySoToolPort, type WorkRunStore } from "../core/contracts/work.ts";
import type { PiEngine } from "./models.ts";

const completionSchema = z.object({
    content: z.string(), tokens_in: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tokens_out: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    amount_mist: decimalMistSchema, reservation_nonce: decimalMistSchema.nullable(), billing_state: z.enum(["captured", "cancelled_zero_cost"]),
    reserve_digest: z.string().nullable(), capture_digest: z.string().nullable(), provider_generation_id: z.string().nullable().optional(),
    finish_reason: z.string().nullable(), tool_calls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.string() })),
});
export type MySoCompletion = z.infer<typeof completionSchema>;
export interface MySoEngineDependencies {
    scope: ExecutionScope;
    runId: string;
    store: WorkRunStore;
    mcp: MySoToolPort;
    /** Model metadata must come from the deployment catalog; no shared provider API key is used. */
    model: Model<"myso-ai-credit">;
    onBilling?: (completion: MySoCompletion) => void;
}
interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
/** Text-only structured gateway. Reject unsupported media instead of silently omitting it.
 * Collapse pi prompt/tool changes with pi's installed transcript resolver. Thinking signatures
 * are provider-private and never translated into another provider's plain-text prompt. */
function chatRequest(context: TranscriptContext, modelId: string, maxTokens: number) {
    const resolved = collapseSystemMessages(context);
    const text = (content: string | readonly { type: string; text?: string }[]): string => {
        if (typeof content === "string") return content;
        if (content.some((part) => part.type !== "text")) throw new Error("The MySo gateway currently accepts text; use an authorized artifact reader for media");
        return content.map((part) => part.text ?? "").join("\n");
    };
    const messages: ChatMessage[] = resolved.messages.map((message) => {
        if (message.role === "system" || message.role === "user") return { role: message.role, content: text(message.content) };
        if (message.role === "toolResult") return { role: "tool", tool_call_id: message.toolCallId, content: text(message.content) };
        const calls = message.content.filter((part) => part.type === "toolCall");
        if (calls.some((call) => call.argumentsError)) throw new Error("Invalid previous tool arguments must be resolved before inference");
        return {
            role: "assistant", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || null,
            ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
        };
    });
    const tools = getCurrentTools(context.messages).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    return { model_id: modelId, messages, ...(tools.length ? { tools } : {}), max_tokens: maxTokens };
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function empty(model: Model<"myso-ai-credit">): AssistantMessage {
    return { role: "assistant", api: model.api, provider: "myso", model: model.id, content: [], stopReason: "pending", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

/** A non-streaming completion presented through pi's event contract. Content events are emitted
 * only after the whole reply and billing result have been durably saved. No synthetic timed tokens,
 * built-in retry, ambient provider fallback or conversion of MIST billing into a USD estimate. */
export function createMySoEngine(deps: MySoEngineDependencies): PiEngine {
    if (deps.model.provider !== "myso" || deps.model.api !== "myso-ai-credit") throw new Error("An authenticated MySo catalog model is required");
    const streamFn: StreamFunction = (model, context, options) => {
        const output = new AssistantMessageEventStream();
        const message = empty(deps.model);
        void (async () => {
            let operationId: string | undefined;
            let saved = false;
            let acquired = false;
            try {
                if (model.id !== deps.model.id || model.provider !== "myso") throw new Error("Model identity changed");
                if (options?.apiKey || options?.headers || options?.onPayload || options?.samplingParams || model.samplingParams) throw new Error("MySo model calls cannot override authenticated transport or billing inputs");
                const maxTokens = options?.maxTokens ?? deps.model.maxTokens;
                if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > Math.min(deps.model.maxTokens, 32768)) throw new Error("Invalid model output token limit");
                options?.signal?.throwIfAborted();
                const activeRun = await deps.store.get(deps.scope, deps.runId);
                if (!activeRun) throw new Error("The work run is unavailable before AI reservation");
                const activeSteps = Object.entries(activeRun.stepStatus).filter(([, status]) => status === "running" || status === "verifying");
                const stepId = activeSteps.length === 1 ? activeSteps[0]![0] : undefined;
                const request = chatRequest(context, model.id, maxTokens);
                const hash = createHash("sha256").update(canonical({ request, stepId: stepId ?? null })).digest("hex");
                const operation = await deps.store.reserveOperation(deps.scope, { runId: deps.runId, toolCallId: `model:${hash}`, toolName: "ai_chat", inputHash: hash, ...(stepId ? { stepId } : {}) });
                operationId = operation.id; acquired = operation.acquired;
                let raw: unknown;
                if (operation.status === "succeeded") { raw = operation.result; saved = true; }
                else {
                    if (!operation.acquired) throw new Error("The prior model call requires reconciliation; no second inference was dispatched");
                    output.push({ type: "start", partial: message });
                    const result = await deps.mcp.callTool("ai_chat", { request: { ...request, idempotency_key: operation.idempotencyKey, work_run_id: deps.runId, work_operation_id: operation.id } }, options?.signal);
                    if (!result.ok) {
                        await deps.store.settleOperation(deps.scope, operation.id, { status: result.error?.retryable ? "reconciling" : "failed", result, error: result.error?.message });
                        saved = true;
                        throw new Error(result.error?.approvalRequired ? "AI spending requires the owner's policy approval" : "AI inference failed; inspect the recorded operation before retrying");
                    }
                    raw = result.data;
                    // Save even a malformed provider reply: a successful bill cannot be made to disappear by a parser error.
                    await deps.store.settleOperation(deps.scope, operation.id, { status: "succeeded", result: raw });
                    saved = true;
                }
                const completion = completionSchema.parse(raw);
                const terminal = completion.finish_reason;
                if (!["stop", "tool_calls", "length"].includes(terminal ?? "")) throw new Error("Provider completion reason is unavailable or unsuccessful; review the recorded call");
                if ((terminal === "tool_calls") !== (completion.tool_calls.length > 0)) throw new Error("Provider tool-call completion is inconsistent");
                if (new Set(completion.tool_calls.map((call) => call.id)).size !== completion.tool_calls.length) throw new Error("Provider returned duplicate tool-call IDs");
                if (terminal === "length" && completion.tool_calls.length) throw new Error("A truncated tool call cannot execute");
                const calls = completion.tool_calls.map((call) => {
                    const args: unknown = JSON.parse(call.arguments);
                    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
                    return { type: "toolCall" as const, id: `${operation.id}:${call.id}`, name: call.name, arguments: args as JsonObject };
                });
                deps.onBilling?.(completion);
                message.usage = { ...message.usage, input: completion.tokens_in, output: completion.tokens_out, totalTokens: completion.tokens_in + completion.tokens_out };
                message.responseId = completion.provider_generation_id ?? undefined;
                if (operation.status === "succeeded") output.push({ type: "start", partial: message });
                if (completion.content) {
                    const index = message.content.length;
                    message.content.push({ type: "text", text: "" }); output.push({ type: "text_start", contentIndex: index, partial: message });
                    message.content[index] = { type: "text", text: completion.content };
                    output.push({ type: "text_delta", contentIndex: index, delta: completion.content, partial: message });
                    output.push({ type: "text_end", contentIndex: index, content: completion.content, partial: message });
                }
                for (const call of calls) {
                    const index = message.content.length;
                    message.content.push(call); output.push({ type: "toolcall_start", contentIndex: index, partial: message });
                    output.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
                }
                message.stopReason = terminal === "tool_calls" ? "toolUse" : terminal === "length" ? "length" : "stop";
                output.push({ type: "done", reason: message.stopReason, message });
            } catch {
                if (operationId && acquired && !saved) {
                    try { await deps.store.settleOperation(deps.scope, operationId, { status: "reconciling", error: "Model outcome unknown; reconcile before dispatching another paid call" }); }
                    catch { /* Durable pending intent remains a dispatch barrier if outcome persistence also fails. */ }
                }
                message.stopReason = options?.signal?.aborted ? "aborted" : "error";
                message.errorMessage = "MySo inference could not finish. Review the saved operation, billing and any required approval before continuing.";
                output.push({ type: "error", reason: message.stopReason, error: message });
            } finally { output.end(); }
        })();
        return output;
    };
    return { model: deps.model, streamFn, level: "off" };
}
