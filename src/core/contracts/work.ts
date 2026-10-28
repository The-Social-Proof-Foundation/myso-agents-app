import { z } from "zod";

export const decimalMistSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= (1n << 64n) - 1n, "Amount exceeds u64");
const objectId = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
/** Old encrypted plans may contain app-side budget controls. Drop them before
 * strict parsing; MYSO and AI-credit authority comes from live chain policy. */
const stripLegacyBudgetControls = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const current = { ...(value as Record<string, unknown>) };
    delete current.actionBudgetMist;
    delete current.aiBudgetMist;
    return current;
};
export const workTaskEvidenceEventSchema = z.enum(["TaskOffered", "TaskAccepted", "TaskDelivered", "TaskReceiptSettled", "TaskRefunded", "TaskCancelled", "TaskDisputed", "TaskDisputeFeePaid", "TaskDisputeCancelled", "TaskDisputeResolved", "CaseOpened", "CaseAppealed", "CaseCancelled"]);
const workTaskEvidenceAlternativeSchema = z.array(workTaskEvidenceEventSchema).min(1).max(13)
    .refine((events) => new Set(events).size === events.length, "Alternative task evidence event types must be unique");
export const executionScopeSchema = z.object({
    network: z.enum(["mainnet", "testnet", "devnet", "localnet"]),
    owner: objectId,
    accountId: objectId,
    agentId: objectId,
    organizationId: objectId.optional(),
    platformId: objectId.optional(),
}).strict();
export type ExecutionScope = z.infer<typeof executionScopeSchema>;

const workStepObjectSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    title: z.string().min(1).max(200),
    dependsOn: z.array(z.string()).max(100),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(30),
    /** Every listed transition must be backed by finalized task history or a matching verified task/jury receipt for this linked task. */
    taskEvidenceEvents: z.array(workTaskEvidenceEventSchema).min(1).max(13).refine((events) => new Set(events).size === events.length, "Task evidence event types must be unique").optional(),
    /** At least one complete event group must be backed by finalized task history or a verified receipt. */
    taskEvidenceEventAlternatives: z.array(workTaskEvidenceAlternativeSchema).min(1).max(8)
        .refine((groups) => new Set(groups.map((group) => [...group].sort().join("|"))).size === groups.length, "Alternative task evidence groups must be unique").optional(),
    assigneeAgentId: objectId.optional(),
    deadline: z.iso.datetime().optional(),
}).strict();
export const workStepSchema = z.preprocess(stripLegacyBudgetControls, workStepObjectSchema);
export const workPlanSchema = z.object({
    version: z.number().int().positive(),
    goal: z.string().min(1).max(10000),
    steps: z.array(workStepSchema).min(1).max(100),
}).strict();
export type WorkPlan = z.infer<typeof workPlanSchema>;
export type WorkStep = z.infer<typeof workStepSchema>;

const taskCloseStep = (dependsOn: string): WorkStep => ({
    id: "close_outcome",
    title: "Close the task outcome",
    dependsOn: [dependsOn],
    acceptanceCriteria: ["Finish only after one terminal outcome is verified: settlement, refund, a resolved dispute paired with settlement or refund, or a cancelled dispute paired with its cancelled case. A paid appeal is not closure."],
    taskEvidenceEventAlternatives: [["TaskReceiptSettled"], ["TaskRefunded"], ["TaskDisputeResolved", "TaskReceiptSettled"], ["TaskDisputeResolved", "TaskRefunded"], ["TaskDisputeCancelled", "CaseCancelled"]],
});

/** Named-seller buyer plan, from the funded offer through a terminal close. */
export function namedSellerBuyerSteps(offered: boolean): WorkStep[] {
    const decision = {
        id: "record_buyer_decision", title: "Record the buyer's task decision", dependsOn: ["review_delivery"],
        acceptanceCriteria: ["If the delivery satisfies the agreed criteria, settle it. If it does not, submit a timely evidence-backed dispute instead of settling. Verify a matching finalized event group; opening a dispute records the buyer's decision but does not claim the jury process is complete."],
        taskEvidenceEventAlternatives: [["TaskReceiptSettled"], ["TaskRefunded"], ["TaskDisputed", "CaseOpened"], ["TaskDisputeResolved", "TaskReceiptSettled"], ["TaskDisputeResolved", "TaskRefunded"]],
    } satisfies WorkStep;
    const review = { id: "review_delivery", title: "Review the seller's delivered artifact", dependsOn: [offered ? "await_acceptance" : "verify_scope"], acceptanceCriteria: ["Wait for the seller's finalized delivery, retrieve only participant-authorized artifact bytes, verify the committed digest and assess each agreed acceptance criterion."], taskEvidenceEvents: ["TaskDelivered"] } satisfies WorkStep;
    const opening: WorkStep[] = offered ? [
        { id: "verify_offer", title: "Verify the funded task offer", dependsOn: [], acceptanceCriteria: ["Confirm the owner is the buyer, the offer is still open, and the buyer-signed private task scope matches the on-chain digest."], taskEvidenceEvents: ["TaskOffered"] },
        { id: "await_acceptance", title: "Wait for seller acceptance", dependsOn: ["verify_offer"], acceptanceCriteria: ["Do not direct seller work or take accepted-task actions while the offer remains open. Continue only after the seller's finalized acceptance event is present in participant task history."], taskEvidenceEvents: ["TaskAccepted"] },
    ] : [
        { id: "verify_scope", title: "Verify accepted task scope", dependsOn: [], acceptanceCriteria: ["Read the participant-authorized task record and signature-verified task room; confirm the buyer assignment, accepted scope digest and agreed criteria."], taskEvidenceEvents: ["TaskAccepted"] },
    ];
    return [...opening, review, decision, taskCloseStep("record_buyer_decision")];
}

/** Named-seller plan, from acceptance through delivery and a terminal close. */
export function namedSellerSellerSteps(criterion: string): WorkStep[] {
    return [
        { id: "verify_scope", title: "Verify accepted task scope", dependsOn: [], acceptanceCriteria: ["Read the participant-authorized task record and signature-verified task room; confirm the seller assignment and compare the private scope digest with the accepted task."], taskEvidenceEvents: ["TaskAccepted"] },
        { id: "prepare_delivery", title: "Prepare and verify the requested deliverable", dependsOn: ["verify_scope"], acceptanceCriteria: [criterion, "Store the exact deliverable through the authorized private R2 upload flow and verify its digest before delivery."] },
        { id: "deliver_task", title: "Deliver the verified task artifact", dependsOn: ["prepare_delivery"], acceptanceCriteria: ["Submit the task delivery using the exact uploaded artifact reference and complete only after a finalized TaskDelivered receipt is verified."], taskEvidenceEvents: ["TaskDelivered"] },
        taskCloseStep("deliver_task"),
    ];
}
export type WorkRunStatus = "planned" | "running" | "yielded" | "waiting_for_input" | "waiting_for_approval" | "reconciling" | "completed" | "delivered" | "settled" | "disputed" | "refunded" | "cancelled" | "failed";
export type WorkStepStatus = "pending" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";
export interface WorkEventEvidence {
    eventType: string;
    sourceEventId: string;
}

export interface WorkReceipt {
    id: string;
    kind: "action" | "task_delivery" | "task_settlement" | "ai_reservation" | "ai_capture" | "knowledge_purchase";
    operationId: string;
    digest: string;
    /** Assigned by a trusted chain/receipt adapter, never by model tool arguments. */
    verification: "pending" | "verified" | "rejected";
    amountMist?: string;
    /** Exact sender gas charge read from finalized fullnode effects, separate from action value. */
    gasCostMist?: string;
    /** Storage rebate exceeding the transaction's gross gas usage, if any. */
    gasRefundMist?: string;
    artifactDigest?: string;
    /** Stable finalized task-history event IDs linked to this receipt. */
    sourceEvidenceIds?: string[];
    /** Typed task and paired jury events verified from this finalized transaction. */
    eventEvidence?: WorkEventEvidence[];
    taskId?: string;
    recordedAt: string;
}
export interface WorkTaskLifecycleEvent {
    taskId: string;
    action: string;
    operationId: string;
    digest: string;
    verification: "pending" | "verified" | "rejected";
    eventTypes: string[];
    sourceEvidenceIds?: string[];
    eventEvidence?: WorkEventEvidence[];
    recordedAt: string;
}
export interface WorkVerifiedTaskState {
    taskId: string;
    status: number;
    transactionDigest: string;
    operationId?: string;
    sourceEventId?: string;
    checkpoint?: string;
    eventType: string;
    evidence: "finalized_fullnode_task_event";
    recordedAt: string;
}
export interface WorkTaskHistoryEvent {
    eventType: string;
    occurredAtMs: number;
    sourceEventId: string;
    status: number | null;
    digest?: string;
    verification: "indexer_preview" | "fullnode_unavailable" | "fullnode_mismatch" | "finalized_fullnode_task_event" | "checkpoint_pending_task_event" | "failed_task_transaction" | "fullnode_event_mismatch" | "fullnode_unavailable_or_unknown";
    checkpoint?: string | null;
}
export interface WorkTaskHistory {
    taskId: string;
    events: WorkTaskHistoryEvent[];
    evidenceSource: "participant_indexed_history_with_fullnode_event_checks" | "task_history_unavailable";
    nextOffset: number | null;
    /** True when the durable journal reached its retention cap before the source history ended. */
    truncated?: boolean;
}
export interface WorkArtifact {
    id: string;
    uri: string;
    contentDigest: string;
    mediaType: string;
    contentLength: number;
    ownerAccountId: string;
    taskId?: string;
    sourceEvidenceIds: string[];
    verification: "pending" | "verified" | "rejected";
    transactionDigest?: string;
}
export interface WorkRun {
    id: string;
    scope: ExecutionScope;
    revision: number;
    status: WorkRunStatus;
    taskId?: string;
    /** Participant role bound by Memory from the authenticated task record. */
    taskRole?: "buyer" | "seller";
    roomId?: string;
    marketplaceTask?: { taskId: string; status: number; transactionId: string; role?: "buyer" | "seller"; evidence: "participant_indexer_preview" };
    taskLifecycleEvents?: WorkTaskLifecycleEvent[];
    verifiedTaskState?: WorkVerifiedTaskState;
    taskHistory?: WorkTaskHistory;
    plan: WorkPlan;
    stepStatus: Record<string, WorkStepStatus>;
    stepEvidence?: Record<string, string[]>;
    artifacts: WorkArtifact[];
    receipts: WorkReceipt[];
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    cancelRequestedAt?: string | null;
    /** Encrypted by the durable adapter; decoded only within this authenticated scope. */
    messages?: unknown[];
}
export interface WorkOperation {
    id: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    inputHash: string;
    /** Exact tool arguments, encrypted by MYDATA at reservation time for receipt recovery. */
    toolInput?: unknown;
    idempotencyKey: string;
    maxAmountMist?: string;
    /** The sole running/verifying plan step active when an AI reservation was made. */
    stepId?: string;
    status: "pending" | "succeeded" | "failed" | "reconciling";
    result?: unknown;
    error?: string;
}

export const knowledgeOfferSchema = z.object({
    listingId: objectId,
    sellerAccountId: objectId,
    graphId: z.string().min(1).max(200),
    graphVersion: z.number().int().positive(),
    access: z.enum(["one_time", "subscription"]),
    priceMist: decimalMistSchema,
    subscriptionDays: z.number().int().min(1).optional(),
    encryptedManifestUri: z.string().min(1).max(2048),
    ciphertextDigest: z.string().regex(/^[0-9a-f]{64}$/),
    terms: z.string().min(1).max(10000),
}).strict().superRefine((offer, ctx) => {
    if (offer.access === "subscription" && !offer.subscriptionDays) ctx.addIssue({ code: "custom", path: ["subscriptionDays"], message: "Subscription duration is required" });
    if (offer.access === "one_time" && offer.subscriptionDays !== undefined) ctx.addIssue({ code: "custom", path: ["subscriptionDays"], message: "One-time access has no subscription duration" });
});
export type KnowledgeOffer = z.infer<typeof knowledgeOfferSchema>;
export interface KnowledgeEvidence {
    id: string;
    sourceId: string;
    sourceVersion: string;
    scope: ExecutionScope;
    visibility: "private" | "organization" | "room";
    receiptId?: string;
    artifactId?: string;
    derivationEvidenceIds: string[];
    state: "asserted" | "verified" | "disputed" | "superseded" | "revoked";
}

/** Durable implementations must bind every operation to scope and enforce expectedPlanVersion atomically. */
export interface WorkRunStore {
    create(scope: ExecutionScope, id: string, plan: WorkPlan, taskId?: string): Promise<WorkRun>;
    get(scope: ExecutionScope, runId: string): Promise<WorkRun | null>;
    /** Close a run only after the durable journal confirms every step and side effect. */
    complete(scope: ExecutionScope, runId: string): Promise<WorkRun>;
    savePlan(scope: ExecutionScope, runId: string, expectedPlanVersion: number, plan: WorkPlan): Promise<WorkRun>;
    reserveOperation(scope: ExecutionScope, input: Omit<WorkOperation, "id" | "idempotencyKey" | "status"> & { toolInput?: Record<string, unknown> }): Promise<WorkOperation & { acquired: boolean }>;
    settleOperation(scope: ExecutionScope, operationId: string, update: Pick<WorkOperation, "status" | "result" | "error">): Promise<void>;
    /** Attach a chain action receipt re-read from its configured scoped verifier. */
    appendActionReceipt(scope: ExecutionScope, runId: string, operationId: string): Promise<WorkReceipt>;
    /** Persist the next service-verified task history page in the encrypted run snapshot. */
    refreshTaskHistory(scope: ExecutionScope, runId: string): Promise<{ run: WorkRun; added: number; complete: boolean; truncated: boolean }>;
    appendTaskArtifact(scope: ExecutionScope, runId: string, operationId: string): Promise<WorkArtifact>;
    updateStep(scope: ExecutionScope, runId: string, stepId: string, expectedStatus: WorkStepStatus, status: WorkStepStatus, evidenceIds?: string[]): Promise<WorkRun>;
}
export interface ScopedTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    idempotent: boolean;
}
export interface MySoToolPort {
    listTools(): Promise<ScopedTool[]>;
    callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean; approvalRequired: boolean } }>;
}
