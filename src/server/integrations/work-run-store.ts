import { z } from "zod";
import { executionScopeSchema, workPlanSchema, decimalMistSchema, type ExecutionScope, type MySoToolPort, type WorkArtifact, type WorkOperation, type WorkPlan, type WorkReceipt, type WorkRun, type WorkRunStore } from "../../core/contracts/work.ts";
import { sameExecutionScope, validateWorkPlan } from "../../core/work.ts";

const runSchema = z.object({
    id: z.uuid(), scope: executionScopeSchema, revision: z.number().int().positive(),
    status: z.enum(["planned", "running", "yielded", "waiting_for_input", "waiting_for_approval", "reconciling", "completed", "delivered", "settled", "disputed", "refunded", "cancelled", "failed"]),
    taskId: z.string().optional(), taskRole: z.enum(["buyer", "seller"]).optional(), roomId: z.string().optional(), plan: workPlanSchema,
    taskLifecycleEvents: z.array(z.object({ taskId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), action: z.string().regex(/^task\.[a-z_]+\.v1$/), operationId: z.uuid(), digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), verification: z.enum(["pending", "verified", "rejected"]), eventTypes: z.array(z.string().min(1).max(300)).max(32), sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(32).optional(), eventEvidence: z.array(z.object({eventType:z.string().min(1).max(300),sourceEventId:z.string().min(1).max(160)}).strict()).max(32).optional(), recordedAt: z.string() }).strict()).max(500).optional(),
    verifiedTaskState: z.object({ taskId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), status: z.number().int().min(0).max(6), transactionDigest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), operationId: z.uuid().optional(), sourceEventId: z.string().min(1).max(160).optional(), checkpoint: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(), eventType: z.string().min(1).max(300), evidence: z.literal("finalized_fullnode_task_event"), recordedAt: z.string() }).strict().optional(),
    taskHistory: z.object({taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),events:z.array(z.object({eventType:z.string().min(1).max(100),occurredAtMs:z.number().int().safe().nonnegative(),sourceEventId:z.string().min(1).max(160),status:z.number().int().min(0).max(6).nullable(),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).optional(),verification:z.enum(["indexer_preview","fullnode_unavailable","fullnode_mismatch","finalized_fullnode_task_event","checkpoint_pending_task_event","failed_task_transaction","fullnode_event_mismatch","fullnode_unavailable_or_unknown"]),checkpoint:z.string().nullable().optional()}).passthrough()).max(10000),evidenceSource:z.enum(["participant_indexed_history_with_fullnode_event_checks","task_history_unavailable"]),nextOffset:z.number().int().min(1).max(100100).nullable(),truncated:z.boolean().optional()}).strict().optional(),
    stepStatus: z.record(z.string(), z.enum(["pending", "running", "verifying", "succeeded", "failed", "cancelled"])),
    stepEvidence: z.record(z.string(), z.array(z.string())).optional(),
    artifacts: z.array(z.object({ id: z.string(), uri: z.string(), contentDigest: z.string().regex(/^[0-9a-f]{64}$/), mediaType: z.string(), contentLength: z.number().int().positive().max(512*1024), ownerAccountId: z.string(), taskId: z.string().optional(), sourceEvidenceIds: z.array(z.string()), verification: z.enum(["pending", "verified", "rejected"]), transactionDigest: z.string().optional() })),
    receipts: z.array(z.object({ id: z.string(), kind: z.enum(["action", "task_delivery", "task_settlement", "ai_reservation", "ai_capture", "knowledge_purchase"]), operationId: z.string(), digest: z.string(), verification: z.enum(["pending", "verified", "rejected"]), amountMist: decimalMistSchema.optional(), gasCostMist: decimalMistSchema.optional(), gasRefundMist: decimalMistSchema.optional(), artifactDigest: z.string().optional(), sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(32).optional(), eventEvidence: z.array(z.object({eventType:z.string().min(1).max(300),sourceEventId:z.string().min(1).max(160)}).strict()).max(32).optional(), taskId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(), recordedAt: z.string() })),
    createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(), cancelRequestedAt: z.string().nullable().optional(), messages: z.array(z.unknown()).optional(),
});
const operationSchema = z.object({
    id: z.uuid(), runId: z.uuid(), toolCallId: z.string(), toolName: z.string(), inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().min(8).max(128), status: z.enum(["pending", "succeeded", "failed", "reconciling"]),
    maxAmountMist: decimalMistSchema.optional(), stepId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(), result: z.unknown().optional(), error: z.string().nullable().optional(), acquired: z.boolean(),
});
/** The MCP credential and scope are bound once per caller, never shared through global app stores.
 * The memory service stamps authority and uses MYDATA-encrypted snapshots/results in Postgres.
 * No plaintext filesystem copy or in-memory fallback is created by this adapter. */
export class MySoWorkRunStore implements WorkRunStore {
    constructor(private readonly mcp: MySoToolPort, private readonly scope: ExecutionScope, private readonly turnToken?: string) { executionScopeSchema.parse(scope); }
    private assertScope(scope: ExecutionScope): void {
        if (!sameExecutionScope(this.scope, executionScopeSchema.parse(scope))) throw new Error("Work store execution scope mismatch");
    }
    private async call(name: string, input: Record<string, unknown>): Promise<unknown> {
        const result = await this.mcp.callTool(name, input);
        if (!result.ok) throw new Error(`${result.error?.code ?? "WORK_UNAVAILABLE"}: ${result.error?.message ?? "Work storage unavailable"}`);
        return result.data;
    }
    private run(value: unknown): WorkRun {
        const run = runSchema.parse(value);
        this.assertScope(run.scope); validateWorkPlan(run.plan);
        return run;
    }
    private requireTurn(): string { if (!this.turnToken) throw new Error("A live work turn lease is required"); return this.turnToken; }
    async acquireTurn(runId: string, requestId: string, inputHash: string, expectedRevision: number) {
        const result = z.object({ acquired: z.boolean(), id: z.uuid(), status: z.string(), token: z.uuid().optional() }).parse(await this.call("work_run_acquire_turn", { runId, request: { requestId, inputHash, expectedRevision } }));
        if (!result.acquired) return { acquired: false as const, id: result.id, status: result.status };
        if (!result.token) throw new Error("Work service did not provide its lease fence");
        return { acquired: true as const, id: result.id, status: result.status, store: new MySoWorkRunStore(this.mcp, this.scope, result.token) };
    }
    async renewTurn(runId: string): Promise<boolean> {
        const result = z.object({ renewed: z.boolean() }).parse(await this.call("work_run_renew_turn", { runId, request: { turnToken: this.requireTurn() } }));
        return result.renewed;
    }
    async checkpoint(runId: string, messages: unknown[]): Promise<void> {
        await this.call("work_run_checkpoint", { runId, request: { turnToken: this.requireTurn(), messages } });
    }
    async finishTurn(runId: string, turnId: string, messages: unknown[], disposition: "idle" | "yielded" | "waiting_for_input" | "waiting_for_approval" | "failed"): Promise<void> {
        await this.call("work_run_finish_turn", { runId, request: { turnToken: this.requireTurn(), turnId, messages, disposition } });
    }
    async create(scope: ExecutionScope, id: string, plan: WorkPlan, taskId?: string): Promise<WorkRun> {
        this.assertScope(scope); z.uuid().parse(id); validateWorkPlan(plan);
        if (taskId !== undefined) z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(taskId);
        return this.run(await this.call("work_run_create", { request: { id, plan, ...(taskId ? { taskId } : {}) } }));
    }
    async get(scope: ExecutionScope, runId: string): Promise<WorkRun | null> {
        this.assertScope(scope); z.uuid().parse(runId);
        const result = await this.mcp.callTool("work_run_get", { runId });
        if (!result.ok && ["NOT_FOUND", "BLOB_NOT_FOUND"].includes(result.error?.code ?? "")) return null;
        if (!result.ok) throw new Error(`${result.error?.code ?? "WORK_UNAVAILABLE"}: work run unavailable`);
        const run = this.run(result.data);
        if (run.id !== runId) throw new Error("Work service returned a different run");
        return run;
    }
    async complete(scope: ExecutionScope, runId: string): Promise<WorkRun> {
        this.assertScope(scope); z.uuid().parse(runId);
        const run = this.run(await this.call("work_run_complete", { runId, request: { confirmed: true } }));
        if (run.id !== runId || run.status !== "completed" || !run.completedAt) throw new Error("Work service did not confirm durable run completion");
        return run;
    }
    async refreshTaskHistory(scope: ExecutionScope, runId: string): Promise<{ run: WorkRun; added: number; complete: boolean; truncated: boolean }> {
        this.assertScope(scope); z.uuid().parse(runId);
        const response = z.object({ run: z.unknown(), added: z.number().int().nonnegative(), complete: z.boolean(), truncated: z.boolean().optional() }).strict().parse(
            await this.call("work_run_refresh_task_history", { runId, request: {} }),
        );
        const run = this.run(response.run);
        if (run.id !== runId || !run.taskId) throw new Error("Task history refresh returned an unlinked or different run");
        return { run, added: response.added, complete: response.complete, truncated: response.truncated ?? run.taskHistory?.truncated ?? false };
    }
    async savePlan(scope: ExecutionScope, runId: string, expectedPlanVersion: number, plan: WorkPlan): Promise<WorkRun> {
        this.assertScope(scope); z.uuid().parse(runId); validateWorkPlan(plan);
        const run = this.run(await this.call("work_run_save_plan", { runId, request: { turnToken: this.requireTurn(), expectedPlanVersion, plan } }));
        if (run.id !== runId) throw new Error("Work service returned a different run");
        return run;
    }
    async reserveOperation(scope: ExecutionScope, input: Omit<WorkOperation, "id" | "idempotencyKey" | "status"> & { toolInput?: Record<string, unknown> }): Promise<WorkOperation & { acquired: boolean }> {
        this.assertScope(scope); z.uuid().parse(input.runId);
        if(input.maxAmountMist!==undefined)decimalMistSchema.parse(input.maxAmountMist);
        const operation = operationSchema.parse(await this.call("work_run_reserve_operation", {
            runId: input.runId, request: { turnToken: this.requireTurn(), toolCallId: input.toolCallId, toolName: input.toolName, inputHash: input.inputHash, ...(input.toolInput?{toolInput:input.toolInput}:{}), ...(input.maxAmountMist?{maxAmountMist:input.maxAmountMist}:{}), ...(input.stepId?{stepId:input.stepId}:{}) },
        }));
        if (operation.runId !== input.runId || operation.toolCallId !== input.toolCallId || operation.inputHash !== input.inputHash || operation.toolName !== input.toolName || operation.maxAmountMist!==input.maxAmountMist || operation.stepId!==input.stepId) throw new Error("Work operation identity mismatch");
        return { ...operation, error: operation.error ?? undefined };
    }
    async settleOperation(scope: ExecutionScope, operationId: string, update: Pick<WorkOperation, "status" | "result" | "error">): Promise<void> {
        this.assertScope(scope); z.uuid().parse(operationId);
        if (update.status === "pending") throw new Error("An outcome cannot return an operation to pending");
        const response = await this.call("work_run_settle_operation", { operationId, request: { ...update, turnToken: this.requireTurn() } });
        if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) throw new Error("Work outcome was not acknowledged");
    }
    async reconcileActionReceipt(scope: ExecutionScope, runId: string, operationId: string): Promise<{resolved:boolean;status:string;digest?:string;registryAction?:string;verification?:string;reason?:string}> {
        this.assertScope(scope); z.uuid().parse(runId); z.uuid().parse(operationId);
        return z.object({resolved:z.boolean(),status:z.string(),digest:z.string().optional(),registryAction:z.string().optional(),verification:z.string().optional(),reason:z.string().optional()}).strict().parse(
            await this.call("work_run_reconcile_action_receipt", {runId,request:{turnToken:this.requireTurn(),operationId}}),
        );
    }
    async appendActionReceipt(scope: ExecutionScope, runId: string, operationId: string): Promise<WorkReceipt> {
        this.assertScope(scope); z.uuid().parse(runId); z.uuid().parse(operationId);
        const result = await this.call("work_run_append_action_receipt", { runId, request: { turnToken: this.requireTurn(), operationId } });
        const receipt = z.object({ id: z.string(), kind: z.enum(["action", "task_delivery", "task_settlement"]), operationId: z.uuid(), digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), verification: z.enum(["pending", "verified", "rejected"]), gasCostMist: decimalMistSchema.optional(), gasRefundMist: decimalMistSchema.optional(), artifactDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(32).optional(), eventEvidence: z.array(z.object({eventType:z.string().min(1).max(300),sourceEventId:z.string().min(1).max(160)}).strict()).max(32).optional(), taskId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(), recordedAt: z.string() }).strict().parse((result as {receipt?: unknown}).receipt);
        if (receipt.operationId !== operationId) throw new Error("Task receipt operation identity mismatch");
        return receipt;
    }
    async appendTaskArtifact(scope: ExecutionScope, runId: string, operationId: string): Promise<WorkArtifact> {
        this.assertScope(scope); z.uuid().parse(runId); z.uuid().parse(operationId);
        const result = await this.call("work_run_append_task_artifact", { runId, request: { turnToken: this.requireTurn(), operationId } });
        const artifact = z.object({ id: z.uuid(), uri: z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{64}\/[0-9a-f]{64}$/), contentDigest: z.string().regex(/^[0-9a-f]{64}$/), mediaType: z.string(), contentLength: z.number().int().positive().max(512*1024), ownerAccountId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), taskId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), sourceEvidenceIds: z.array(z.string()), verification: z.enum(["pending", "verified", "rejected"]), transactionDigest: z.string().optional() }).strict().parse((result as {artifact?: unknown}).artifact);
        if (artifact.id !== operationId) throw new Error("Task artifact operation identity mismatch");
        return artifact;
    }
    async updateStep(scope: ExecutionScope, runId: string, stepId: string, expectedStatus: WorkRun["stepStatus"][string], status: WorkRun["stepStatus"][string], evidenceIds: string[] = []): Promise<WorkRun> {
        this.assertScope(scope); z.uuid().parse(runId);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stepId)) throw new Error("Invalid work step ID");
        const run = this.run(await this.call("work_run_update_step", { runId, stepId, request: { turnToken: this.requireTurn(), expectedStatus, status, evidenceIds } }));
        if (run.id !== runId || !(stepId in run.stepStatus)) throw new Error("Work step update identity mismatch");
        return run;
    }
}
