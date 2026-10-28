import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { decimalMistSchema, workPlanSchema, type MySoToolPort, type WorkRun } from "../core/contracts/work.ts";
import { normalizeWorkOperationInput, workOperationInputHash } from "../core/work-operation-input.ts";
import { roomAttachmentDownloadSchema, roomAttachmentUploadSchema, roomHistoryPageSchema, roomHistoryRequestSchema, roomMemberPageSchema, roomReceiptUpdateRequestSchema, roomReceiptUpdateResultSchema, roomReceiptsSchema } from "../core/contracts/messaging.ts";
import { createWorkCoordinator } from "../agent/coordinator-agent.ts";
import { createMySoEngine } from "../agent/myso-engine.ts";
import { toToolResult } from "../agent/tool-execute.ts";
import { HOSTED_WORK_PRIVATE_CONTEXT_TOOLS, HOSTED_WORK_PRIVATE_GRAPH_TOOLS, HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS, HOSTED_WORK_ROOM_CONTENT_TOOLS, isHostedWorkToolForbidden, requiresHostedPrivateContentSharingConsent } from "../core/hosted-work-tool-policy.ts";
import { MySoWorkRunStore } from "./integrations/work-run-store.ts";
import { authenticatedMySo, authenticatedMySoRunWorker, MySoAccessError, mySoErrorResponse, readMySoBrowserSession } from "./myso-auth.ts";

const NO_CACHE={"Cache-Control":"no-store"};
const sameChainId=(left:string,right:string)=>left.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===right.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
function canonicalRecoveryInput(value:unknown):string{
    if(value===null||typeof value!=="object")return JSON.stringify(value);
    if(Array.isArray(value))return `[${value.map(canonicalRecoveryInput).join(",")}]`;
    const record=value as Record<string,unknown>;
    return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonicalRecoveryInput(record[key])}`).join(",")}}`;
}
function recoveryTransactionDigest(value:unknown):string|undefined{
    if(!value||typeof value!=="object")return undefined;
    const envelope=value as Record<string,unknown>;const data=envelope.data&&typeof envelope.data==="object"?envelope.data as Record<string,unknown>:{};
    const chain=data.chain&&typeof data.chain==="object"?data.chain as Record<string,unknown>:{};
    return [data.digest,data.transactionDigest,data.txDigest,chain.digest].find((item):item is string=>typeof item==="string"&&item.length>0);
}
function recoveryResultData(value:unknown,fields:Record<string,unknown>):Record<string,unknown>{
    return value&&typeof value==="object"&&!Array.isArray(value)?{...(value as Record<string,unknown>),...fields}:{result:value,...fields};
}
function transcriptContainsHostedWorkForbiddenTool(messages:AgentMessage[]):boolean{
    return messages.some(message=>{
        if(message.role==="assistant")return message.content.some(part=>part.type==="toolCall"&&isHostedWorkToolForbidden(part.name));
        return message.role==="toolResult"&&isHostedWorkToolForbidden(message.toolName);
    });
}
function transcriptContainsAnyTool(messages:AgentMessage[],toolNames:ReadonlySet<string>):boolean{
    return messages.some(message=>message.role==="assistant"
        ?message.content.some(part=>part.type==="toolCall"&&toolNames.has(part.name))
        :message.role==="toolResult"&&toolNames.has(message.toolName));
}
function redactPrivateContextTail(messages:AgentMessage[]):{messages:AgentMessage[];redacted:boolean}{
    const privateSources=HOSTED_WORK_PRIVATE_CONTEXT_TOOLS;
    const index=messages.findIndex(message=>message.role==="assistant"
        ?message.content.some(part=>part.type==="toolCall"&&privateSources.has(part.name))
        :message.role==="toolResult"&&privateSources.has(message.toolName));
    return index<0?{messages,redacted:false}:{messages:messages.slice(0,index),redacted:true};
}
function durableWorkTranscript(messages:AgentMessage[]):AgentMessage[]{
    // Private room and graph results are usable in the live, consented model turn,
    // but must not become durable work-run history or survive consent expiry.
    return redactPrivateContextTail(messages).messages.map(message=>message.role==="assistant"?{
        ...message,
        content:message.content.map(part=>part.type==="toolCall"&&part.name==="task_upload_deliverable"
            ?{...part,arguments:normalizeWorkOperationInput(part.name,part.arguments) as typeof part.arguments}
            :part),
    }:message);
}
async function body(req:Request,maxBytes=128*1024):Promise<unknown>{
    if(!req.headers.get("content-type")?.includes("application/json"))throw new MySoAccessError(415,"Send a JSON request");
    if(!req.body)throw new MySoAccessError(400,"Request is empty");
    const reader=req.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new MySoAccessError(413,"Request is too large");chunks.push(next.value);}}
    finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new MySoAccessError(400,"Request is not valid JSON");}
}
const createSchema=z.object({id:z.uuid(),plan:workPlanSchema,taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional()}).strict();
const automationEnabledSchema=z.object({expected_version:z.number().int().positive(),enabled:z.boolean()}).strict();
const automationConfigurationInputSchema=z.object({trigger_set:z.record(z.string(),z.unknown()),action:z.object({kind:z.enum(["memory_relayer_call","registered_action","webhook","work_run"]),config:z.record(z.string(),z.unknown())}).strict()}).strict();
const automationConfigurationSchema=automationConfigurationInputSchema.extend({expected_version:z.number().int().positive()}).strict();
const automationSimulationSchema=z.object({event_family:z.string().trim().min(1).max(128),event_type:z.string().trim().min(1).max(128),payload:z.record(z.string(),z.unknown()).default({})}).strict().refine(value=>Buffer.byteLength(JSON.stringify(value.payload))<=32*1024,"Event payload must be at most 32 KiB");
const automationRunNowSchema=z.object({requestId:z.uuid()}).strict();
const automationCancelSchema=z.object({expected_version:z.number().int().positive(),note:z.string().trim().min(8).max(1000),confirmed:z.literal(true)}).strict();
const automationCreateSchema=z.object({name:z.string().trim().min(1).max(200),delegateRef:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),triggerKind:z.enum(["event","cron","interval"]).default("event"),eventType:z.string().trim().max(128).optional(),cronExpr:z.string().trim().min(1).max(100).optional(),timezone:z.string().trim().min(1).max(80).optional(),intervalMs:z.number().int().min(60_000).max(2_147_483_647).optional(),actionId:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/),actionConfig:z.record(z.string(),z.unknown()).default({}),idempotencyKey:z.uuid().optional()}).strict().superRefine((input,ctx)=>{
    if(input.triggerKind==="event"&&!input.eventType)ctx.addIssue({code:"custom",path:["eventType"],message:"Event triggers require an exact event type"});
    if(input.triggerKind==="cron"&&(!input.cronExpr||!input.timezone))ctx.addIssue({code:"custom",path:["cronExpr"],message:"Scheduled triggers require a cron expression and IANA timezone"});
    if(input.triggerKind==="interval"&&input.intervalMs===undefined)ctx.addIssue({code:"custom",path:["intervalMs"],message:"Interval triggers require an interval of at least 60 seconds"});
});
const automationReconcileSchema=z.object({jobId:z.uuid(),resolution:z.enum(["confirmed_succeeded","confirmed_not_executed_retry"]),note:z.string().trim().min(8).max(1000),confirmed:z.literal(true)}).strict();
const taskAcceptSchema=z.object({termsDigestHex:z.string().regex(/^[0-9a-fA-F]{64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskReviewSchema=z.object({stars:z.number().int().min(1).max(5),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskOpenDisputeSchema=z.object({feeCoinId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskRespondDisputeSchema=z.object({feeCoinId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskDisputeCancelSchema=z.object({idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskDisputeAppealSchema=z.object({feeCoinId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskDisputeEvidenceSchema=z.object({digestHex:z.string().regex(/^[0-9a-f]{64}$/),uri:z.string().min(1).max(2048),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskDisputeAgreementSchema=z.object({action:z.enum(["propose","accept","clear"]),outcome:z.number().int().min(0).max(2).optional(),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict().refine(value=>value.action==="propose"?value.outcome!==undefined:value.outcome===undefined);
const taskRefundSchema=z.object({action:z.enum(["propose","accept","reject","withdraw"]),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskRoomBindSchema=z.object({idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const juryCaseId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const juryActionSchema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("accept"),caseId:juryCaseId,idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict(),
    z.object({operation:z.literal("commit"),caseId:juryCaseId,commitmentHex:z.string().regex(/^[0-9a-fA-F]{64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict(),
    z.object({operation:z.literal("reveal"),caseId:juryCaseId,outcome:z.number().int().min(0).max(255),rationaleDigestHex:z.string().regex(/^[0-9a-fA-F]{64}$/),evidenceRefs:z.array(z.string().regex(/^(0|[1-9][0-9]*)$/)).max(1000),bundleDigestHex:z.string().regex(/^[0-9a-fA-F]{64}$/),saltHex:z.string().regex(/^(?:[0-9a-fA-F]{2}){16,64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict(),
    z.object({operation:z.literal("claim_fee"),caseId:juryCaseId,idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict(),
]);
const taskCreateOfferSchema=z.object({
    sellerAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    amountMist:z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value=>BigInt(value)>0n&&BigInt(value)<=18446744073709551615n),
    scopeDigestHex:z.string().regex(/^[0-9a-fA-F]{64}$/),title:z.string().trim().min(1).max(256),
    acceptWindowMs:z.string().regex(/^[1-9][0-9]*$/).refine(value=>BigInt(value)<=18446744073709551615n),
    deliveryWindowMs:z.string().regex(/^[1-9][0-9]*$/).refine(value=>BigInt(value)<=18446744073709551615n),
    settleWindowMs:z.string().regex(/^[1-9][0-9]*$/).refine(value=>BigInt(value)<=18446744073709551615n),
    paymentCoinId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),roomGroupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    platformId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/),
}).strict();
const taskDeliverSchema=z.object({digestHex:z.string().regex(/^[0-9a-fA-F]{64}$/),uri:z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{64}\/[0-9a-fA-F]{64}$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const taskUploadSchema=z.object({contentBase64:z.string().min(4).max(700000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/),acknowledgeBuyerAccess:z.literal(true)}).strict();
const taskSettleSchema=z.object({idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict();
const roomMemberChangeRequestSchema=z.discriminatedUnion("action",[
    z.object({action:z.literal("invite"),member:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),acknowledgeHistoryAccess:z.literal(true)}).strict(),
    z.object({action:z.literal("remove"),member:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),acknowledgeFutureAccessRemoval:z.literal(true)}).strict(),
]);
const multisigConfigSchema=z.object({threshold:z.number().int().min(1).max(2550),members:z.array(z.object({address:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),publicKeyBase64:z.string().min(16).max(128).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),weight:z.number().int().min(1).max(255)}).strict()).min(2).max(10)}).strict();
const turnSchema=z.object({
    requestId:z.uuid(),input:z.string().min(1).max(10000),modelId:z.string().min(1).max(200),
    maxModelTurns:z.number().int().min(1).max(100),maxOutputTokens:z.number().int().min(1).max(32768),
    allowedTools:z.array(z.string().min(1).max(100)).max(256),allowRoomHistory:z.boolean().default(false),allowPrivateGraph:z.boolean().default(false),allowPrivateTaskArtifacts:z.boolean().default(false),allowPrivateContentSharing:z.boolean().default(false),continueRun:z.boolean().default(false),
}).strict();
const workerTurnSchema=z.object({
    requestId:z.uuid(),modelId:z.string().min(1).max(200),maxModelTurns:z.number().int().min(1).max(100),maxOutputTokens:z.number().int().min(1).max(32768),continueRun:z.boolean().default(false),
    allowRoomHistory:z.boolean().default(false),allowPrivateGraph:z.boolean().default(false),allowPrivateTaskArtifacts:z.boolean().default(false),allowPrivateContentSharing:z.boolean().default(false),
}).strict();
const catalogSchema=z.object({models:z.array(z.object({id:z.string(),display_name:z.string(),context_length:z.number().int().positive().nullable(),max_output_tokens:z.number().int().positive().nullable(),supports_tools:z.boolean()}))});
async function attachMarketplaceTask(run:WorkRun|null,mcp:MySoToolPort):Promise<WorkRun|null>{
    if(!run?.taskId)return run;
    const result=await mcp.callTool("task_get",{id:run.taskId});if(!result.ok)return run;
    const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int().min(0).max(6),transactionId:z.string().min(1).max(128)}).passthrough().safeParse(result.data);
    if(!task.success)return run;
    const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
    if(normalize(task.data.taskId)!==normalize(run.taskId))return run;
    return {...run,marketplaceTask:{taskId:task.data.taskId,status:task.data.status,transactionId:task.data.transactionId,role:run.taskRole,evidence:"participant_indexer_preview"}};
}
export async function handleMySoWork(req:Request,action:"context"|"catalog"|"runs"|"run"|"run-ai-usage"|"run-operations"|"run-operation-receipt"|"run-task-history-refresh"|"turn"|"cancel-run"|"complete-run"|"view"|"jury"|"owner-agents"|"owner-agent-authority"|"account-configure-multisig"|"room-history"|"room-receipts"|"room-members"|"room-name"|"room-archive"|"task-market-stats"|"task-market-sellers"|"task-market-funding-coins"|"task-create-offer"|"task-offer-receipt"|"task-room-binding-receipt"|"task-room"|"task-detail"|"task-dispute-detail"|"task-dispute-agreement"|"task-dispute-agreement-receipt"|"task-appeal-dispute"|"task-appeal-dispute-receipt"|"task-submit-dispute-evidence"|"task-submit-dispute-evidence-receipt"|"task-respond-dispute"|"task-respond-dispute-receipt"|"task-cancel-dispute"|"task-cancel-dispute-receipt"|"task-accept"|"task-accept-receipt"|"task-review"|"task-review-receipt"|"task-refund"|"task-refund-receipt"|"task-open-dispute"|"task-open-dispute-receipt"|"task-cancel-offer"|"task-cancel-offer-receipt"|"task-bind-room"|"task-upload"|"task-deliver"|"task-action-receipt"|"task-settle"|"task-settlement-receipt"|"task-deliverable"|"automation-create"|"automation-validate"|"automation-rename"|"automation-configuration-validate"|"automation-configuration-update"|"automation-simulate-event"|"automation-archive"|"automation-restore"|"automation-delete"|"automation-enabled"|"automation-cancel-job"|"automation-run-now"|"automation-runs"|"automation-run-reconcile"|"automation-deliveries"|"automation-reconcile"|"automation-cancel-delivery"|"automation-delegates"|"automation-delegate-key-events"|"automation-delegate-keys"|"automation-store-delegate",runId?:string,workerBinding?:{keyRef:string;accountId:string;parentAgentId:string;workerAgentId:string;runId:string;credential:string}):Promise<Response>{
    try{
        if(workerBinding&&(action!=="turn"||runId!==workerBinding.runId))throw new MySoAccessError(403,"A run worker may execute only its bound work run");
        if(action==="context" && !process.env.MYSO_AGENTS_MCP_URL?.trim()){
            const session=readMySoBrowserSession(req);
            return Response.json({signedIn:true,owner:session.owner??null,label:"Signed in",scope:null},{headers:NO_CACHE});
        }
        const auth=workerBinding?await authenticatedMySoRunWorker(workerBinding):await authenticatedMySo(req);
        const store=new MySoWorkRunStore(auth.mcp,auth.scope);
        if(action==="jury"){
            if(req.method==="GET"){
                const query=new URL(req.url).searchParams;
                const resource=z.enum(["assignments","case","bundle","rationales","receipt","cranks"]).parse(query.get("resource")??"assignments");
                const limit=z.coerce.number().int().min(1).max(resource==="assignments"?200:50).parse(query.get("limit")??20);
                const offset=z.coerce.number().int().min(0).max(100000).parse(query.get("offset")??0);
                let toolName:string;let args:Record<string,unknown>;
                if(resource==="assignments"){
                    toolName="jury_list_assignments";args={limit,offset};
                    if(query.has("status"))args.status=z.string().regex(/^[1-6](,[1-6]){0,5}$/).parse(query.get("status"));
                }else if(resource==="case"){
                    toolName="jury_get_case";args={id:juryCaseId.parse(query.get("id"))};
                }else if(resource==="bundle"){
                    const caseId=juryCaseId.parse(query.get("id"));
                    const round=z.coerce.number().int().min(0).max(255).parse(query.get("round"));
                    toolName="jury_get_case_bundle";args={id:caseId,round};
                }else if(resource==="rationales"){
                    toolName="jury_list_case_rationales";args={id:juryCaseId.parse(query.get("id"))};
                }else if(resource==="receipt"){
                    toolName="jury_get_action_receipt";args={id:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(query.get("id"))};
                }else{toolName="jury_list_cranks";args={limit,offset};}
                const result=await auth.mcp.callTool(toolName,args,req.signal);
                if(!result.ok)throw new MySoAccessError(403,"This jury read is unavailable to the connected agent");
                if(resource==="bundle"){
                    const id=String(args.id);const round=Number(args.round);
                    const payload=z.object({bundle:z.object({caseId:juryCaseId,round:z.number().int().nonnegative()}).passthrough(),digestHex:z.string().regex(/^[0-9a-f]{64}$/i)}).parse(result.data);
                    if(!sameChainId(payload.bundle.caseId,id)||payload.bundle.round!==round||createHash("sha256").update(canonicalRecoveryInput(payload.bundle),"utf8").digest("hex")!==payload.digestHex.toLowerCase())throw new MySoAccessError(502,"The verified jury bundle digest did not match its contents");
                }
                if(resource==="case"){
                    const value=z.object({caseId:juryCaseId}).passthrough().parse(result.data);
                    if(!sameChainId(value.caseId,String(args.id)))throw new MySoAccessError(502,"The jury case does not match the requested case");
                }
                return Response.json(result.data,{headers:NO_CACHE});
            }
            if(req.method!=="POST")throw new MySoAccessError(405,"Use GET to read jury data or POST to submit a juror action");
            const input=juryActionSchema.parse(await body(req));
            const {operation,caseId,idempotencyKey,...vote}=input;
            const toolName=({accept:"jury_accept",commit:"jury_commit_vote",reveal:"jury_reveal_vote",claim_fee:"jury_claim_fee"} as const)[operation];
            const parameters={caseId,agentId:auth.scope.agentId,...vote,idempotencyKey};
            const result=await auth.mcp.callTool(toolName,parameters,req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The juror action was not submitted; refresh the case and confirm its current phase and live juror permission");
            const response=z.object({digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).optional(),chain:z.object({digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).passthrough().optional()}).passthrough().parse(result.data);
            const digest=response.digest??response.chain?.digest;
            if(!digest)throw new MySoAccessError(502,"The jury action response has no transaction digest to verify");
            return Response.json({operation,caseId,agentId:auth.scope.agentId,idempotencyKey,digest,submission:result.data},{status:202,headers:NO_CACHE});
        }
        if(action==="context")return Response.json({signedIn:true,owner:auth.scope.owner,scope:auth.scope,label:auth.label,derivedAddress:auth.derivedAddress,rpcUrl:auth.rpcUrl,socialChain:auth.socialChain},{headers:NO_CACHE});
        if(action==="account-configure-multisig"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to validate a native MySo multisig signer configuration");
            const input=multisigConfigSchema.parse(await body(req));
            const result=await auth.mcp.callTool("account_configure_multisig",input,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The MySo multisig descriptor tool is unavailable to the connected agent");
            const descriptor=z.object({format:z.literal("myso-protocol-multisig-v1"),address:z.string().regex(/^0x[0-9a-fA-F]{64}$/),publicKeyBase64:z.string().min(16).max(128),threshold:z.number().int().min(1).max(2550),members:z.array(z.object({address:z.string().regex(/^0x[0-9a-fA-F]{64}$/),publicKeyBase64:z.string().min(16).max(128),weight:z.number().int().min(1).max(255)}).strict()).min(2).max(10),execution:z.string().min(1).max(500)}).strict().parse(result.data);
            const canonical=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(descriptor.threshold!==input.threshold||descriptor.members.length!==input.members.length||descriptor.members.some((member,index)=>member.address!==canonical(input.members[index]!.address)||member.publicKeyBase64!==input.members[index]!.publicKeyBase64||member.weight!==input.members[index]!.weight))throw new MySoAccessError(502,"The MCP multisig descriptor did not preserve the requested public signer set");
            return Response.json(descriptor,{headers:NO_CACHE});
        }
        if(action==="automation-delegate-keys"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect the automation bridge encryption keys");
            const result=await auth.mcp.callTool("automation_get_delegate_keys",{},req.signal);
            if(!result.ok)throw new MySoAccessError(503,"Automation bridge encryption keys are unavailable");
            const keys=z.object({keys:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),publicKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict()).min(1).max(32)}).strict().parse(result.data);
            return Response.json(keys,{headers:NO_CACHE});
        }
        if(action==="automation-store-delegate"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to store an encrypted automation delegate key");
            const input=z.object({
                delegateRef:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
                delegate:z.object({
                    agent_object_id:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),
                    mydata_key_id:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
                    encrypted_key:z.string().regex(/^[A-Za-z0-9_-]{1,4096}$/),
                    delegate_class:z.enum(["memory","task_worker","juror","action_worker"]),
                    allowed_action_ids:z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)).max(16),
                }).strict(),
            }).strict().parse(await body(req));
            const result=await auth.mcp.callTool("automation_store_delegate",input,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The encrypted delegate key could not be stored for this account and agent");
            return Response.json({stored:true},{headers:NO_CACHE});
        }
        if(action==="automation-create"||action==="automation-validate"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to validate or create an automation");
            const input=automationCreateSchema.parse(await body(req));
            let cursor:string|undefined;let delegate:{delegate_ref:string;agent_object_id:string;delegate_class:"memory"|"task_worker"|"juror"|"action_worker";allowed_action_ids:string[]}|null=null;
            for(let pageNumber=0;pageNumber<20;pageNumber++){
                const pageResult=await auth.mcp.callTool("automation_list_delegates",{limit:50,...(cursor?{cursor}:{})},req.signal);
                if(!pageResult.ok)throw new MySoAccessError(403,"Automation delegates are unavailable to the connected agent");
                const page=z.object({data:z.array(z.object({delegate_ref:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),agent_object_id:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),delegate_class:z.enum(["memory","task_worker","juror","action_worker"]),allowed_action_ids:z.array(z.string().min(1).max(100)).max(16)}).passthrough()).max(200),has_next_page:z.boolean(),next_cursor:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable()}).strict().parse(pageResult.data);
                delegate=page.data.find(item=>item.delegate_ref===input.delegateRef)??null;
                if(delegate||!page.has_next_page)break;
                if(!page.next_cursor)throw new MySoAccessError(502,"The delegate page is missing its next cursor");
                cursor=page.next_cursor;
            }
            if(!delegate)throw new MySoAccessError(404,"Choose a delegate registered for this account and agent");
            const durableWork=input.actionId==="myso.work_run.v1";
            if(!durableWork&&!sameChainId(delegate.agent_object_id,auth.scope.agentId))throw new MySoAccessError(403,"This delegate belongs to a different agent");
            if(durableWork){
                if(delegate.delegate_class!=="action_worker"||delegate.allowed_action_ids.length===0)throw new MySoAccessError(403,"Durable harness automations require an action_worker with an explicit on-chain action allowlist");
            }else{
                if(delegate.delegate_class!=="task_worker"&&delegate.delegate_class!=="juror"&&delegate.delegate_class!=="action_worker")throw new MySoAccessError(403,"Choose a signing delegate authorized for the selected event action");
                if(!delegate.allowed_action_ids.includes(input.actionId))throw new MySoAccessError(403,"This delegate is not authorized for the selected action");
            }
            let durableConfig:{runId:string;turn:{modelId:string;maxModelTurns:number;maxOutputTokens:number;allowRoomHistory:boolean;allowPrivateGraph:boolean;allowPrivateTaskArtifacts:boolean;allowPrivateContentSharing:boolean}}|undefined;
            if(durableWork){
                durableConfig=z.object({runId:z.uuid(),turn:z.object({modelId:z.string().min(1).max(200),maxModelTurns:z.number().int().min(1).max(100),maxOutputTokens:z.number().int().min(1).max(32768),allowRoomHistory:z.boolean().default(false),allowPrivateGraph:z.boolean().default(false),allowPrivateTaskArtifacts:z.boolean().default(false),allowPrivateContentSharing:z.boolean().default(false)}).strict()}).strict().parse(input.actionConfig);
                if(durableConfig.turn.allowPrivateContentSharing&&!durableConfig.turn.allowRoomHistory&&!durableConfig.turn.allowPrivateGraph&&!durableConfig.turn.allowPrivateTaskArtifacts)throw new MySoAccessError(400,"Private-content sharing consent requires an approved private content source");
                const run=await store.get(auth.scope,durableConfig.runId);
                if(!run)throw new MySoAccessError(404,"Choose a work run owned by this account and parent agent");
                if(durableConfig.turn.allowPrivateTaskArtifacts&&!run.taskId)throw new MySoAccessError(400,"Private task-artifact access requires a run linked to an accepted task");
                const models=await auth.mcp.callTool("ai_list_models",{},req.signal);
                if(!models.ok)throw new MySoAccessError(503,"MySo model discovery is unavailable; no automation was created");
                const model=catalogSchema.parse(models.data).models.find(item=>item.id===durableConfig!.turn.modelId);
                if(!model?.supports_tools||!model.context_length||!model.max_output_tokens||durableConfig.turn.maxOutputTokens>model.max_output_tokens)throw new MySoAccessError(400,"Choose a tool-capable MySo model within its published output limit");
            }
            const live=await auth.mcp.callTool("automation_get_delegate_status",{delegateRef:delegate.delegate_ref},req.signal);
            if(!live.ok)throw new MySoAccessError(503,"Live on-chain delegate status is unavailable; no automation was created");
            const status=z.object({status:z.enum(["active","inactive"]),delegate_class:z.enum(["memory","task_worker","juror","action_worker"])}).passthrough().parse(live.data);
            if(status.status!=="active"||status.delegate_class!==delegate.delegate_class)throw new MySoAccessError(409,"The delegate is not currently active on chain");
            const family=durableWork||delegate.delegate_class==="task_worker"||delegate.delegate_class==="action_worker"?"task":"jury";
            const actionConfig:Record<string,unknown>=durableWork?durableConfig!:{...input.actionConfig,action_id:input.actionId};
            delete actionConfig.key_ref;
            if(action==="automation-create"&&!input.idempotencyKey)throw new MySoAccessError(400,"Automation creation requires a stable idempotency key");
            const trigger=input.triggerKind==="event"
                ?{kind:"event",event_family:family,event_type:input.eventType!}
                :input.triggerKind==="cron"
                    ?{kind:"cron",event_family:family,event_type:"",cron_expr:input.cronExpr!,timezone:input.timezone!,replay_behavior:"allow_all"}
                    :{kind:"interval",event_family:family,event_type:"",interval_ms:input.intervalMs!};
            const job={name:input.name,trigger_set:{match_mode:"any",evaluation_window_ms:0,triggers:[trigger]},target_agent_object_id:auth.scope.agentId,target_agent_key_ref:`delegate:${delegate.delegate_ref}`,action:{kind:durableWork?"work_run":"registered_action",config:actionConfig},retry_policy:{max_attempts:3,jitter_ms:1000},...(action==="automation-create"?{idempotency_key:input.idempotencyKey}:{})};
            if(action==="automation-validate"){
                const result=await auth.mcp.callTool("automation_validate_job",{job},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"Preflight failed. Check the exact event type, action parameters, and live delegate policy; no job was created.");
                return Response.json(z.object({valid:z.literal(true),action_kind:z.string(),trigger_count:z.number().int().positive(),enabled_on_create:z.boolean(),dispatch_performed:z.literal(false),notice:z.string()}).strict().parse(result.data),{headers:NO_CACHE});
            }
            const result=await auth.mcp.callTool("automation_create_job",{job},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The automation was not created. Check the event type, action parameters, and live delegate policy before retrying.");
            const created=z.object({id:z.uuid(),name:z.string(),enabled:z.boolean()}).passthrough().parse(result.data);
            return Response.json(created,{status:201,headers:NO_CACHE});
        }
        if(action==="automation-enabled"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to pause or resume an automation");
            const jobId=z.uuid().parse(runId);
            const input=automationEnabledSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_set_job_enabled",{jobId,request:input});
            if(!result.ok)throw new MySoAccessError(409,"This automation changed since it was loaded. Refresh its list and retry with the latest version.");
            return Response.json(result.data,{headers:NO_CACHE});
        }
        if(action==="automation-cancel-job"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to stop an automation and clear queued deliveries");
            const jobId=z.uuid().parse(runId);const request=automationCancelSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_cancel_job",{jobId,request},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This automation changed since it was loaded. Refresh before canceling queued work.");
            return Response.json(z.object({jobId:z.uuid(),version:z.number().int().positive(),cancelledPending:z.number().int().nonnegative(),inFlight:z.number().int().nonnegative(),enabled:z.literal(false)}).strict().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-rename"){
            if(req.method!=="PATCH")throw new MySoAccessError(405,"Use PATCH to rename an automation");
            const jobId=z.uuid().parse(runId);const input=z.object({expected_version:z.number().int().positive(),name:z.string().trim().min(1).max(200)}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("automation_update_job",{jobId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This automation changed since it was loaded. Refresh its list before renaming it.");
            return Response.json(z.object({id:z.uuid(),name:z.string(),enabled:z.boolean(),archived:z.boolean()}).passthrough().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-configuration-validate"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to validate an automation configuration");
            const jobId=z.uuid().parse(runId);const input=automationConfigurationInputSchema.parse(await body(req));
            const current=await auth.mcp.callTool("automation_get_job",{jobId},req.signal);
            if(!current.ok)throw new MySoAccessError(404,"This automation is unavailable to the connected account");
            const job=z.object({id:z.uuid(),name:z.string().min(1).max(200),enabled:z.boolean(),trigger_set:z.record(z.string(),z.unknown()),target_agent_object_id:z.string(),target_agent_key_ref:z.string(),action:z.object({kind:z.string(),config:z.record(z.string(),z.unknown())}),memory_scope:z.string().optional(),retry_policy:z.record(z.string(),z.unknown()).optional()}).passthrough().parse(current.data);
            if(job.enabled)throw new MySoAccessError(409,"Pause the automation before changing its triggers or action");
            const proposed={name:job.name,trigger_set:input.trigger_set,target_agent_object_id:job.target_agent_object_id,target_agent_key_ref:job.target_agent_key_ref,action:input.action,memory_scope:job.memory_scope??"chat-app",retry_policy:job.retry_policy??{max_attempts:3,jitter_ms:1000}};
            const result=await auth.mcp.callTool("automation_validate_job",{job:proposed},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Configuration preflight failed; the saved job was not changed");
            return Response.json(z.object({valid:z.literal(true),action_kind:z.string(),trigger_count:z.number().int().positive(),enabled_on_create:z.boolean(),dispatch_performed:z.literal(false),notice:z.string()}).strict().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-configuration-update"){
            if(req.method!=="PATCH")throw new MySoAccessError(405,"Use PATCH to update an automation configuration");
            const jobId=z.uuid().parse(runId);const input=automationConfigurationSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_update_job_configuration",{jobId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The automation changed since it was loaded, or it has active, queued, or uncertain work. Refresh before retrying.");
            return Response.json(z.object({id:z.uuid(),name:z.string(),enabled:z.boolean(),archived:z.boolean()}).passthrough().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-simulate-event"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to simulate an automation event");
            const jobId=z.uuid().parse(runId);const request=automationSimulationSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_simulate_event",{jobId,request},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This event could not be evaluated against the selected automation");
            return Response.json(z.object({jobId:z.uuid(),eventFamily:z.string(),eventType:z.string(),matchedTriggerIndexes:z.array(z.number().int().nonnegative()),eventTriggerCount:z.number().int().nonnegative(),nonEventTriggerCount:z.number().int().nonnegative(),eventOnlyWouldSatisfyTriggerSet:z.boolean(),dispatchPerformed:z.literal(false),persisted:z.literal(false),limitations:z.array(z.string())}).strict().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-archive"||action==="automation-restore"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to archive or restore an automation");
            const jobId=z.uuid().parse(runId);const input=z.object({expected_version:z.number().int().positive()}).strict().parse(await body(req));const tool=action==="automation-archive"?"automation_archive_job":"automation_restore_job";
            const result=await auth.mcp.callTool(tool,{jobId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This automation changed since it was loaded. Refresh its list before archiving or restoring it.");
            return Response.json(z.object({id:z.uuid(),name:z.string(),enabled:z.boolean(),archived:z.boolean()}).passthrough().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="automation-delete"){
            if(req.method!=="DELETE")throw new MySoAccessError(405,"Use DELETE to permanently remove an automation");
            const jobId=z.uuid().parse(runId);const input=z.object({confirmed:z.literal(true),expected_version:z.number().int().positive()}).strict().parse(await body(req));
            if(input.confirmed!==true)throw new MySoAccessError(400,"Explicit deletion confirmation is required");
            const result=await auth.mcp.callTool("automation_delete_job",{jobId,request:{expected_version:input.expected_version}},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This automation has active or uncertain work, or is outside the connected account's authority");
            return Response.json({deleted:true},{headers:NO_CACHE});
        }
        if(action==="automation-run-now"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to queue an automation run");
            const jobId=z.uuid().parse(runId);const input=automationRunNowSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_run_job_now",{jobId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This automation cannot be queued by the connected agent");
            return Response.json(result.data,{status:202,headers:NO_CACHE});
        }
        if(action==="automation-runs"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect automation runs");
            const jobId=z.uuid().parse(runId);const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(100).parse(query.get("limit")??50);
            const offset=z.coerce.number().int().min(0).max(100000).parse(query.get("offset")??0);
            const result=await auth.mcp.callTool("automation_list_runs",{jobId,limit,offset},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Run history is unavailable for this automation");
            const rows=z.array(z.object({id:z.uuid(),job_id:z.uuid(),status:z.string(),attempt:z.number().int(),error:z.string().nullable(),started_at:z.iso.datetime(),finished_at:z.iso.datetime().nullable()}).passthrough()).parse(result.data);
            return Response.json({items:rows,hasMore:rows.length===limit,nextOffset:rows.length===limit?offset+rows.length:null},{headers:NO_CACHE});
        }
        if(action==="automation-run-reconcile"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to reconcile a stale automation run");
            const runIdValue=z.uuid().parse(runId);const input=z.object({jobId:z.uuid(),resolution:z.enum(["confirmed_succeeded","closed_uncertain_no_replay"]),note:z.string().trim().min(8).max(1000),confirmed:z.literal(true)}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("automation_reconcile_orphan_run",{jobId:input.jobId,runId:runIdValue,request:{resolution:input.resolution,note:input.note,confirmed:true}},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This run is not an old orphan without a linked delivery, or is outside the connected account's authority");
            return Response.json(result.data,{headers:NO_CACHE});
        }
        if(action==="automation-deliveries"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect automation deliveries");
            const jobId=z.uuid().parse(runId);const query=new URL(req.url).searchParams;const limit=z.coerce.number().int().min(1).max(100).parse(query.get("limit")??50);const offset=z.coerce.number().int().min(0).max(100000).parse(query.get("offset")??0);
            const result=await auth.mcp.callTool("automation_list_deliveries",{jobId,limit,offset},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Delivery history is unavailable for this automation");
            const rows=z.array(z.object({id:z.uuid(),job_id:z.uuid(),event_key:z.string(),status:z.string(),attempts:z.number().int(),lease_until:z.string().nullable().optional(),error:z.string().nullable().optional(),resolved_by:z.string().nullable().optional(),resolution:z.string().nullable().optional(),resolution_note:z.string().nullable().optional()}).passthrough()).parse(result.data);
            return Response.json({items:rows,hasMore:rows.length===limit,nextOffset:rows.length===limit?offset+rows.length:null},{headers:NO_CACHE});
        }
        if(action==="automation-reconcile"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to reconcile an automation delivery");
            const deliveryId=z.uuid().parse(runId);const input=automationReconcileSchema.parse(await body(req));
            const result=await auth.mcp.callTool("automation_reconcile_delivery",{deliveryId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This delivery is no longer reconciling or is outside the connected account's authority");
            return Response.json(result.data,{headers:NO_CACHE});
        }
        if(action==="automation-cancel-delivery"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to cancel a pending automation delivery");
            const deliveryId=z.uuid().parse(runId);const input=z.object({jobId:z.uuid(),note:z.string().trim().min(8).max(1000),confirmed:z.literal(true)}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("automation_cancel_delivery",{deliveryId,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This delivery is no longer pending or is outside the connected account's authority");
            return Response.json(result.data,{headers:NO_CACHE});
        }
        if(action==="automation-delegates"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect automation delegates");
            const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(50).parse(query.get("limit")??20);
            const cursor=query.has("cursor")?z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).parse(query.get("cursor")):undefined;
            const listing=await auth.mcp.callTool("automation_list_delegates",{limit,...(cursor?{cursor}:{})},req.signal);
            if(!listing.ok)throw new MySoAccessError(502,"Automation delegate metadata is unavailable");
            const page=z.object({data:z.array(z.object({delegate_ref:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),agent_object_id:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),mydata_key_id:z.string().min(1).max(200),delegate_class:z.enum(["memory","task_worker","juror","action_worker"]),allowed_action_ids:z.array(z.string().min(1).max(100)).max(16),created_at:z.string()}).strict()).max(200),has_next_page:z.boolean(),next_cursor:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable()}).strict().parse(listing.data);
            if(page.has_next_page!==!!page.next_cursor||(page.has_next_page&&page.data.length===0))throw new MySoAccessError(502,"The automation delegate cursor is inconsistent");
            const items:Array<(typeof page.data)[number]&{chainStatus:{status:"unavailable"}|{status:"active"|"inactive";delegate_class:"memory"|"task_worker"|"juror"|"action_worker";expires_at_ms:number|null;expires_in_ms:number|null;reason?:string}}> = [];
            for(let offset=0;offset<page.data.length;offset+=4){
                const batch=await Promise.all(page.data.slice(offset,offset+4).map(async delegate=>{
                    const check=await auth.mcp.callTool("automation_get_delegate_status",{delegateRef:delegate.delegate_ref},req.signal);
                    if(!check.ok)return {...delegate,chainStatus:{status:"unavailable" as const}};
                    const status=z.object({status:z.enum(["active","inactive"]),delegate_class:z.enum(["memory","task_worker","juror","action_worker"]),expires_at_ms:z.number().int().nullable(),expires_in_ms:z.number().int().nullable(),reason:z.string().max(500).optional()}).strict().parse(check.data);
                    if(status.delegate_class!==delegate.delegate_class)throw new MySoAccessError(502,"The bridge returned a different delegate class than the stored record");
                    return {...delegate,chainStatus:status};
                }));
                items.push(...batch);
            }
            return Response.json({items,hasNextPage:page.has_next_page,nextCursor:page.next_cursor},{headers:NO_CACHE});
        }
        if(action==="automation-delegate-key-events"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect delegate key history");
            const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(50).parse(query.get("limit")??20);
            const cursor=query.has("cursor")?z.string().regex(/^[1-9][0-9]{0,18}$/).parse(query.get("cursor")):undefined;
            const result=await auth.mcp.callTool("automation_list_delegate_key_events",{limit,...(cursor?{cursor}:{})},req.signal);
            if(!result.ok)throw new MySoAccessError(502,"Delegate key history is unavailable");
            const page=z.object({data:z.array(z.object({id:z.string().regex(/^[1-9][0-9]{0,18}$/),delegate_ref:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),agent_object_id:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),mydata_key_id:z.string().min(1).max(200),event_type:z.enum(["created","replaced","deleted"]),recorded_at:z.string()}).strict()).max(200),has_next_page:z.boolean(),next_cursor:z.string().regex(/^[1-9][0-9]{0,18}$/).nullable()}).strict().parse(result.data);
            if(page.has_next_page!==!!page.next_cursor||(page.has_next_page&&page.data.length===0))throw new MySoAccessError(502,"Delegate key history cursor is inconsistent");
            return Response.json({items:page.data,hasNextPage:page.has_next_page,nextCursor:page.next_cursor},{headers:NO_CACHE});
        }
        if(action==="view"){
            const names={tasks:"task_list",agent_tasks:"task_list_for_agent",organization_tasks:"task_list_for_organization",organizations:"organization_list_owned",marketplace:"task_market_list",rooms:"room_list",receipts:"agent_list_receipts",automations:"automation_list_jobs",jury:"jury_list_assignments"} as const;
            if(!runId || !(runId in names))throw new MySoAccessError(404,"View unavailable");
            const name=names[runId as keyof typeof names];
            const page=new URL(req.url).searchParams;const offset=z.coerce.number().int().min(0).max(100000).parse(page.get("offset")??0);
            const limit=z.coerce.number().int().min(1).max(name==="room_list"?200:20).parse(page.get("limit")??20);
            const args:Record<string,unknown>={limit,offset};
            if(name==="task_list"||name==="task_list_for_agent")args.role=z.enum(["buyer","seller"]).parse(page.get("role")??"seller");
            if(name==="jury_list_assignments"&&page.has("status"))args.status=z.string().regex(/^[1-6](,[1-6]){0,5}$/).parse(page.get("status"));
            const result=await auth.mcp.callTool(name,args);
            if(!result.ok)throw new MySoAccessError(502,"This view is unavailable for your current account permissions");
            const rows=name==="organization_list_owned"&&result.data&&typeof result.data==="object"?((result.data as {organizations?:unknown}).organizations):result.data;
            if(!Array.isArray(rows))throw new MySoAccessError(502,"The service returned an unsupported list format");
            return Response.json({items:rows,offset,limit},{headers:NO_CACHE});
        }
        if(action==="owner-agents"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to list agents owned by this account");
            const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(50).parse(query.get("limit")??20);
            const cursor=query.has("cursor")?z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("cursor")):undefined;
            const result=await auth.mcp.callTool("agent_admin_list",{limit,...(cursor?{cursor}:{})},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Owned agent policy is unavailable to this account");
            const page=z.object({
                data:z.array(z.object({agentObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),active:z.boolean(),expectedCapabilities:z.string().regex(/^(0|[1-9][0-9]*)$/),expectedLimitMist:z.union([z.string().regex(/^(0|[1-9][0-9]*)$/),z.literal("unlimited")]),labelPreview:z.object({text:z.string().max(256),truncated:z.boolean(),source:z.literal("on_chain_label_untrusted")}).strict()}).passthrough()).max(50),
                hasNextPage:z.boolean(),nextCursor:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),evidenceSource:z.literal("configured_fullnode"),effectiveAuthority:z.literal("not_computed"),
            }).strict().parse(result.data);
            if(page.hasNextPage!==!!page.nextCursor)throw new MySoAccessError(502,"The owner-agent cursor is inconsistent");
            return Response.json({items:page.data,hasNextPage:page.hasNextPage,nextCursor:page.nextCursor,evidenceSource:page.evidenceSource},{headers:NO_CACHE});
        }
        if(action==="owner-agent-authority"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect the current agent policy");
            const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("agent_admin_get_quote",{id},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"This agent's current policy is unavailable to this account");
            const decimal=z.string().regex(/^(0|[1-9][0-9]*)$/);const limitMist=z.union([decimal,z.literal("unlimited")]);
            const quote=z.object({
                agent:z.object({agentObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),active:z.boolean(),expectedCapabilities:decimal,expectedLimitMist:limitMist,approvalRequiredCaps:decimal,delegatableCaps:decimal,expectedPlatformScope:z.unknown(),organizationId:z.string().nullable(),expiresAtMs:decimal.nullable(),parentObjectId:z.string().nullable(),labelPreview:z.object({text:z.string().max(256),truncated:z.boolean(),source:z.literal("on_chain_label_untrusted")}).strict(),effectiveAuthority:z.object({computed:z.literal(true),activeNow:z.boolean(),accountActive:z.boolean(),currentTimeMs:decimal,effectiveExecutionCapabilitiesMask:decimal,effectivePerActionSpendLimitMist:limitMist,limitSemantics:z.literal("per_action_not_cumulative"),activeChain:z.array(z.object({agentObjectId:z.string(),parentObjectId:z.string().nullable(),active:z.boolean(),expired:z.boolean(),expiresAtMs:decimal.nullable(),depth:decimal}).strict()).max(32),evidenceSource:z.literal("configured_fullnode_live_object_snapshot"),executionRechecksAuthority:z.literal(true)}).strict()}).passthrough(),
                supportedGrantMask:decimal,writesEnabled:z.boolean(),authority:z.literal("owner_wallet"),evidenceSource:z.literal("configured_fullnode"),
            }).strict().parse(result.data);
            if(quote.agent.agentObjectId.toLowerCase()!==id.toLowerCase())throw new MySoAccessError(502,"The authority quote did not match the requested agent");
            return Response.json(quote,{headers:NO_CACHE});
        }
        if(action==="room-history"){
            const query=new URL(req.url).searchParams;
            const request=roomHistoryRequestSchema.parse({uuid:runId,afterOrder:query.has("afterOrder")?Number(query.get("afterOrder")):undefined,beforeOrder:query.has("beforeOrder")?Number(query.get("beforeOrder")):undefined,limit:query.has("limit")?Number(query.get("limit")):20});
            const result=await auth.mcp.callTool("messaging_get_room_history",request,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"This room cannot be read with the connected agent's current MessagingReader access");
            return Response.json(roomHistoryPageSchema.parse(result.data),{headers:NO_CACHE});
        }
        if(action==="room-receipts"){
            const uuid=z.string().uuid().parse(runId);
            if(req.method==="GET"){
                const result=await auth.mcp.callTool("messaging_get_room_receipts",{uuid},req.signal);
                if(!result.ok)throw new MySoAccessError(403,"Room receipts are unavailable to the connected agent");
                return Response.json(roomReceiptsSchema.parse(result.data),{headers:NO_CACHE});
            }
            if(req.method==="POST"){
                const input=roomReceiptUpdateRequestSchema.parse(await body(req));
                const result=await auth.mcp.callTool("messaging_update_room_receipts",{uuid,readUpto:input.readUpto},req.signal);
                if(!result.ok)throw new MySoAccessError(403,"The read receipt could not be updated with the connected agent's current room permission");
                return Response.json(roomReceiptUpdateResultSchema.parse(result.data),{headers:NO_CACHE});
            }
            throw new MySoAccessError(405,"Use GET to inspect room receipts or POST to advance the read watermark");
        }
        if(action==="room-members"){
            if(req.method==="POST"){
                const uuid=z.uuid().parse(runId);
                const input=roomMemberChangeRequestSchema.parse(await body(req));
                if(input.action==="remove"&&sameChainId(input.member,auth.derivedAddress))throw new MySoAccessError(400,"The connected agent cannot remove itself from the room");
                if(input.action==="invite"){
                    const result=await auth.mcp.callTool("messaging_add_room_members",{uuid,members:[input.member],acknowledgeHistoryAccess:input.acknowledgeHistoryAccess},req.signal);
                    if(!result.ok)throw new MySoAccessError(403,"The connected agent cannot invite members to this room");
                    const invitation=z.object({groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),digest:z.string().min(1).max(128).nullable(),grantedMembers:z.array(z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)).min(1).max(50),verification:z.enum(["finalized_reader_and_sender_permissions","already_had_reader_and_sender_permissions"]),source:z.literal("myso_fullnode")}).strict().parse(result.data);
                    if(!invitation.grantedMembers.some(member=>sameChainId(member,input.member)))throw new MySoAccessError(502,"The finalized invite did not grant access to the requested wallet");
                    return Response.json({groupId:invitation.groupId,digest:invitation.digest,member:input.member,historyAccess:"past_and_future",verification:invitation.verification,source:invitation.source},{headers:NO_CACHE});
                }
                const result=await auth.mcp.callTool("messaging_remove_members_rotate_key",{uuid,members:[input.member]},req.signal);
                if(!result.ok)throw new MySoAccessError(403,"The connected agent cannot remove members and rotate this room's key");
                const removal=z.object({groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),digest:z.string().min(1).max(128),removedMembers:z.array(z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)).min(1).max(50),keyVersionBefore:z.string().regex(/^(0|[1-9][0-9]*)$/).max(20),keyVersionAfter:z.string().regex(/^(0|[1-9][0-9]*)$/).max(20),verification:z.literal("finalized_membership_and_key_version"),source:z.literal("myso_fullnode")}).strict().parse(result.data);
                if(!removal.removedMembers.some(member=>sameChainId(member,input.member))||BigInt(removal.keyVersionAfter)<=BigInt(removal.keyVersionBefore))throw new MySoAccessError(502,"The finalized removal did not match the requested member and key rotation");
                return Response.json({groupId:removal.groupId,digest:removal.digest,member:input.member,keyVersionBefore:removal.keyVersionBefore,keyVersionAfter:removal.keyVersionAfter,futureAccess:"revoked",pastAccess:"may_remain_available_or_previously_copied",verification:removal.verification,source:removal.source},{headers:NO_CACHE});
            }
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to inspect current room members or POST to invite a reader");
            const groupId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const cursor=query.has("cursor")?z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(query.get("cursor")):undefined;
            const limit=query.has("limit")?z.coerce.number().int().min(1).max(100).parse(query.get("limit")):50;
            const result=await auth.mcp.callTool("messaging_list_room_members",{id:groupId,limit,...(cursor?{cursor}:{})},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"This room's current membership is unavailable to the connected agent");
            const page=roomMemberPageSchema.parse(result.data);
            if(!sameChainId(page.groupId,groupId))throw new MySoAccessError(502,"The member list belongs to a different room");
            return Response.json(page,{headers:NO_CACHE});
        }
        if(action==="room-name"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to update a room name");
            const uuid=z.uuid().parse(runId);
            const input=z.object({name:z.string().trim().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value),"Room name must contain printable characters")}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("messaging_set_room_name",{uuid,name:input.name},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The connected agent cannot rename this room; live MetadataAdmin permission is required");
            const renamed=z.object({updated:z.literal(true),groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),name:z.string().min(1).max(128),digest:z.string().min(1).max(128),verification:z.literal("fullnode_metadata_refetched"),source:z.literal("myso_fullnode")}).strict().parse(result.data);
            if(renamed.name!==input.name.normalize("NFC"))throw new MySoAccessError(502,"The fullnode-confirmed room name did not match the requested name");
            return Response.json(renamed,{headers:NO_CACHE});
        }
        if(action==="room-archive"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to permanently archive a room");
            const uuid=z.uuid().parse(runId);
            const input=z.object({ownerConfirmation:z.object({owner:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),agentObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),expiresAtMs:z.number().int().safe(),nonce:z.uuid(),signature:z.string().min(40).max(4096)}).strict()}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("messaging_archive_group",{uuid,ownerConfirmation:input.ownerConfirmation},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The room was not archived. The connected agent needs live PermissionsAdmin authority, and the owner must confirm in MySo Agents.");
            const archived=z.object({archived:z.literal(true),groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),digest:z.string().min(1).max(128),verification:z.literal("finalized_archive_transaction"),source:z.literal("myso_fullnode")}).strict().parse(result.data);
            return Response.json(archived,{headers:NO_CACHE});
        }
        if(action==="task-market-stats"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to read Task Marketplace statistics");
            const result=await auth.mcp.callTool("task_market_get_stats",{},req.signal);
            if(!result.ok)throw new MySoAccessError(502,"Task Marketplace statistics are unavailable");
            const stats=z.object({openOffers:z.number().int().safe().nonnegative(),accepted:z.number().int().safe().nonnegative(),delivered:z.number().int().safe().nonnegative(),disputed:z.number().int().safe().nonnegative(),settled:z.number().int().safe().nonnegative(),refunded:z.number().int().safe().nonnegative(),cancelled:z.number().int().safe().nonnegative(),settledLast24h:z.number().int().safe().nonnegative(),activeAgents:z.number().int().safe().nonnegative()}).passthrough().parse(result.data);
            return Response.json({openOffers:stats.openOffers,accepted:stats.accepted,delivered:stats.delivered,disputed:stats.disputed,settled:stats.settled,refunded:stats.refunded,cancelled:stats.cancelled,settledLast24h:stats.settledLast24h,activeAgents:stats.activeAgents},{headers:NO_CACHE});
        }
        if(action==="task-market-sellers"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to browse active Task Marketplace sellers");
            const query=new URL(req.url).searchParams;
            const sort=z.enum(["score","reviews","volume"]).parse(query.get("sort")??"score");
            const min_reviews=z.coerce.number().int().min(0).max(1_000_000).parse(query.get("min_reviews")??0);
            const limit=z.coerce.number().int().min(1).max(50).parse(query.get("limit")??20);
            const offset=z.coerce.number().int().min(0).max(100_000).parse(query.get("offset")??0);
            const result=await auth.mcp.callTool("task_market_list_sellers",{sort,min_reviews,limit,offset},req.signal);
            if(!result.ok)throw new MySoAccessError(502,"The seller directory is unavailable to this agent");
            const sellers=z.array(z.object({
                sellerAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),agentObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
                capabilities:z.number().int().safe().nonnegative(),expiresAtMs:z.number().int().safe().nonnegative().nullable(),
                principal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),label:z.string().max(256),organizationId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),
                reviewCount:z.number().int().safe().nonnegative(),score:z.number().finite(),confidenceBps:z.number().int().safe().nonnegative(),
                settledCount:z.number().int().safe().nonnegative(),volumeMist:z.string().regex(/^(0|[1-9][0-9]*)$/),credibilityBps:z.number().int().safe().nonnegative(),
            }).passthrough()).max(50).parse(result.data);
            return Response.json({items:sellers,sort,min_reviews,limit,offset},{headers:NO_CACHE});
        }
        if(action==="task-market-funding-coins"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to list the connected agent's MYSO task-funding coins");
            const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(50).parse(query.get("limit")??20);
            const cursor=query.has("cursor")?z.string().min(1).max(2048).parse(query.get("cursor")):undefined;
            const result=await auth.mcp.callTool("task_list_agent_funding_coins",{limit,...(cursor?{cursor}:{})},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Agent MYSO coins are unavailable under this agent's current Task Marketplace capability");
            const page=z.object({data:z.array(z.object({coinObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),coinType:z.string().max(512),balanceBaseUnits:z.string().regex(/^(0|[1-9][0-9]*)$/),version:z.string().regex(/^(0|[1-9][0-9]*)$/),digest:z.string().min(1).max(128),previousTransaction:z.string().min(1).max(128)}).strict()).max(50),hasNextPage:z.boolean(),nextCursor:z.string().max(2048).nullable(),agentAddress:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),maxActionSpendMist:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),evidenceSource:z.literal("configured_fullnode"),notice:z.string().max(500)}).strict().parse(result.data);
            if(page.hasNextPage!==!!page.nextCursor||(page.hasNextPage&&page.data.length===0))throw new MySoAccessError(502,"The agent coin cursor is inconsistent");
            return Response.json(page,{headers:NO_CACHE});
        }
        if(action==="task-create-offer"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to create a funded task offer");
            const input=taskCreateOfferSchema.parse(await body(req));
            const roomResult=await auth.mcp.callTool("messaging_list_room_members",{id:input.roomGroupId,limit:100},req.signal);
            if(!roomResult.ok)throw new MySoAccessError(403,"A current fullnode room-membership read is required before creating a private task offer");
            const room=z.object({groupId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),members:z.array(z.object({address:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),permissions:z.array(z.string().min(1).max(512)).max(64)}).strict()).max(100),limit:z.number().int().min(1).max(100),hasNextPage:z.boolean(),nextCursor:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),membershipEvidence:z.literal("configured_fullnode_current_messaging_reader"),source:z.literal("configured_fullnode_permission_table")}).strict().parse(roomResult.data);
            if(!sameChainId(room.groupId,input.roomGroupId)||room.hasNextPage||room.nextCursor!==null)throw new MySoAccessError(502,"The task room membership page did not provide a complete current snapshot");
            const buyerRoomMember=room.members.find(member=>sameChainId(member.address,auth.derivedAddress));
            if(!buyerRoomMember||!buyerRoomMember.permissions.some(permission=>permission.endsWith("::MessagingSender")))throw new MySoAccessError(403,"The authenticated buyer agent must have current MessagingSender permission on the task room");
            const {idempotencyKey,...parameters}=input;
            const result=await auth.mcp.callTool("task_create",{...parameters,scopeDigestHex:input.scopeDigestHex.toLowerCase(),idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The task offer could not be created under the current agent capability, spending policy, or on-chain marketplace terms");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest},{headers:NO_CACHE});
        }
        if(action==="task-offer-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a Task Marketplace offer");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task offer evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.create.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest)throw new MySoAccessError(502,"The task receipt did not match the requested transaction");
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const event=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskOffered")&&typeof item.data.task_id==="string"&&(!receipt.taskId||normalize(item.data.task_id)===normalize(receipt.taskId)));
            if(event){
                const data=event.data;
                const buyerMatches=typeof data.buyer_principal==="string"&&normalize(data.buyer_principal)===normalize(auth.scope.owner)
                    &&typeof data.buyer_memory_account_id==="string"&&normalize(data.buyer_memory_account_id)===normalize(auth.scope.accountId)
                    &&typeof data.buyer_agent_id==="string"&&normalize(data.buyer_agent_id)===normalize(auth.scope.agentId);
                if(!buyerMatches)throw new MySoAccessError(502,"The TaskOffered event does not match the authenticated buyer");
            }
            if(receipt.status==="finalized"&&(!event||!receipt.taskId))throw new MySoAccessError(502,"No finalized TaskOffered event matched this transaction");
            return Response.json({digest:receipt.digest,taskId:receipt.taskId??(typeof event?.data.task_id==="string"?event.data.task_id:null),status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_offered_event":"task_offer_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-room-binding-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify the room-to-task binding");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const expectedGroupId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("groupId"));
            const result=await auth.mcp.callTool("messaging_get_task_room_binding_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Room binding evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("messaging.bind_room_to_task.v1"),groupId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),verification:z.string().max(128)}).passthrough().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(receipt.digest!==digest||normalize(receipt.taskId)!==normalize(expectedTaskId)||normalize(receipt.groupId)!==normalize(expectedGroupId))throw new MySoAccessError(502,"The room binding receipt does not match the expected task and group");
            if(receipt.status==="finalized"&&receipt.verification!=="finalized_agent_room_task_bound_event")throw new MySoAccessError(502,"The room bind event was not verified as finalized");
            return Response.json({digest:receipt.digest,taskId:receipt.taskId,groupId:receipt.groupId,status:receipt.status,verification:receipt.verification},{headers:NO_CACHE});
        }
        if(action==="task-room"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to resolve the room linked to a task");
            const id=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get_room",{id},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"This task room is unavailable to the connected buyer or seller agent");
            const room=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),groupId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),groupUuid:z.uuid(),evidenceSource:z.literal("authorized_task_participant_and_social_indexer_room_binding"),messagingPermission:z.literal("not_proven_by_this_read")}).strict().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(room.taskId)!==normalize(id))throw new MySoAccessError(502,"The room reference belongs to a different task");
            return Response.json(room,{headers:NO_CACHE});
        }
        if(action==="task-accept"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to accept a Task Marketplace offer");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskAcceptSchema.parse(await body(req));
            const result=await auth.mcp.callTool("task_accept",{taskId,sellerAgentId:auth.scope.agentId,termsDigestHex:input.termsDigestHex,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The offer could not be accepted under the connected agent’s current capability, limits, or on-chain terms");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest},{headers:NO_CACHE});
        }
        if(action==="task-accept-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify task acceptance");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(new URL(req.url).searchParams.get("taskId"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task acceptance evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.accept.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"The acceptance receipt does not match the requested transaction and task");
            const event=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskAccepted")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId));
            if(event&&(!sameChainId(String(event.data.seller_agent_id??""),auth.scope.agentId)||!sameChainId(String(event.data.seller_principal??""),auth.scope.owner)))throw new MySoAccessError(502,"The TaskAccepted event does not match the authenticated seller agent and owner");
            if(receipt.status==="finalized"&&!event)throw new MySoAccessError(502,"No finalized TaskAccepted event matched this task");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_accepted_event":"task_accept_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-review"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to review a settled task");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskReviewSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is unavailable to the connected participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(taskId)||task.status!==3)throw new MySoAccessError(409,"Only a currently settled task can be reviewed");
            const buyerActor=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId));
            const sellerActor=normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId);
            if(!buyerActor&&!sellerActor)throw new MySoAccessError(403,"Only a buyer or the assigned seller agent can review this task");
            const raterRole=buyerActor?"buyer":"seller";
            const result=await auth.mcp.callTool("task_review",{taskId,raterRole,stars:input.stars,buyerAccountId:task.buyerMemoryAccountId,sellerAccountId:task.sellerMemoryAccountId,sellerAgentId:task.sellerAgentId,...(task.buyerAgentId?{buyerAgentId:task.buyerAgentId}:{}),idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The review was rejected by task state, existing review, or current agent policy");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,raterRole,stars:input.stars},{headers:NO_CACHE});
        }
        if(action==="task-review-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a task review");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const expectedStars=z.coerce.number().int().min(1).max(5).parse(query.get("stars"));
            const expectedRole=z.enum(["buyer","seller"]).parse(query.get("raterRole"));
            const read=await auth.mcp.callTool("task_get",{id:expectedTaskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is unavailable to the connected participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const buyerActor=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId));
            const sellerActor=normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId);
            if(normalize(task.taskId)!==normalize(expectedTaskId)||expectedRole==="buyer"&&!buyerActor||expectedRole==="seller"&&!sellerActor)throw new MySoAccessError(403,"The requested review does not match this participant");
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Review evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.review.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"The review receipt does not match the requested transaction and task");
            const expectedRoleValue=expectedRole==="buyer"?1:2;
            const event=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskReviewSubmitted")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId)&&item.data.rater_role===expectedRoleValue&&item.data.stars===expectedStars);
            const expectedRaterAgent=expectedRole==="buyer"?task.buyerAgentId:task.sellerAgentId;
            if(event&&(!sameChainId(String(event.data.rater_principal??""),auth.scope.owner)||(expectedRaterAgent===null?event.data.rater_agent_id!==null:typeof event.data.rater_agent_id!=="string"||!sameChainId(event.data.rater_agent_id,expectedRaterAgent))))throw new MySoAccessError(502,"The TaskReviewSubmitted event does not match the authenticated reviewer");
            if(receipt.status==="finalized"&&!event)throw new MySoAccessError(502,"No finalized TaskReviewSubmitted event matched this reviewer and rating");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,raterRole:expectedRole,stars:expectedStars,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_review_submitted_event":"task_review_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-refund"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to update a delivered-task refund proposal");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskRefundSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is unavailable to the connected participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),refundProposer:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)])}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const actorRole=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const proposer=Number(task.refundProposer);
            if(normalize(task.taskId)!==normalize(taskId)||task.status!==2)throw new MySoAccessError(409,"Refund proposals are available only for delivered tasks");
            if(actorRole===0)throw new MySoAccessError(403,"Only the task buyer or assigned seller agent can change a refund proposal");
            if(input.action==="propose"&&(proposer!==0&&proposer!==actorRole)||input.action==="accept"&&(proposer===0||proposer===actorRole)||input.action==="reject"&&(proposer===0||proposer===actorRole)||input.action==="withdraw"&&(proposer===0||proposer!==actorRole))throw new MySoAccessError(409,"The current refund proposal does not permit this action");
            const toolName=({propose:"task_propose_refund",accept:"task_accept_refund",reject:"task_reject_refund",withdraw:"task_withdraw_refund"} as const)[input.action];
            const result=await auth.mcp.callTool(toolName,{taskId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The refund proposal change was rejected by current agent policy or on-chain task state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,action:input.action},{headers:NO_CACHE});
        }
        if(action==="task-refund-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a task refund proposal receipt");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const refundAction=z.enum(["propose","accept","reject","withdraw"]).parse(query.get("action"));
            const registryAction=({propose:"task.propose_refund.v1",accept:"task.accept_refund.v1",reject:"task.reject_refund.v1",withdraw:"task.withdraw_refund.v1"} as const)[refundAction];
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task refund evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.string(),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.registryAction!==registryAction||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"The task refund receipt does not match the requested action and task");
            const taskRead=await auth.mcp.callTool("task_get",{id:expectedTaskId},req.signal);
            if(!taskRead.ok)throw new MySoAccessError(404,"Task details are unavailable to this account");
            const task=z.object({buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskRead.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            if(role===0)throw new MySoAccessError(403,"Only a task participant can verify this receipt");
            const eventName=refundAction==="propose"?"TaskRefundProposed":refundAction==="accept"?"TaskRefunded":"TaskRefundProposalCleared";
            const event=receipt.events.find(item=>item.type.endsWith(`::agent_task::${eventName}`)&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId)&&(refundAction==="propose"?item.data.proposer_role===role:refundAction==="accept"?item.data.refund_kind===1&&typeof item.data.buyer_principal==="string"&&sameChainId(item.data.buyer_principal,task.buyerPrincipal):item.data.cleared_by_role===role&&item.data.reason===(refundAction==="reject"?1:0)));
            if(receipt.status==="finalized"&&!event)throw new MySoAccessError(502,"No finalized task refund event matched this participant and action");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,action:refundAction,status:receipt.status,verification:receipt.status==="finalized"?`finalized_${eventName.replace(/[A-Z]/g,(letter)=>`_${letter.toLowerCase()}`).replace(/^_/ ,"")}_event`:"task_refund_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-dispute-detail"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to read the task dispute");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal);
            if(!result.ok)throw new MySoAccessError(404,"This task has no readable dispute");
            const amount=z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]);
            const count=amount.nullable();
            const round=z.object({round:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),acceptDeadlineMs:amount,commitDeadlineMs:count,revealDeadlineMs:count,tally:z.array(amount).max(16).nullable(),abstain:count,revealed:count,decisive:z.boolean().nullable(),leading:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]).nullable(),appealDeadlineMs:count}).passthrough();
            const evidence=z.object({index:amount,submitter:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),round:amount,kind:amount,digest:z.string().min(1).max(256),uri:z.string().max(2048),submittedAtMs:amount}).passthrough();
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),openedByRole:z.union([z.number().int().min(1).max(2),z.string().regex(/^[12]$/)]),state:z.union([z.number().int().min(0).max(8),z.string().regex(/^[0-8]$/)]),feeEachMist:amount,buyerPaidMist:amount,sellerPaidMist:amount,openedAtMs:amount,agreementProposer:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]),agreementOutcome:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]).nullable(),case:z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),subjectKind:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),subjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),stage:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),currentRound:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),finalOutcome:count,appealable:z.boolean(),appealsUsed:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),failedAppeal:z.boolean(),participants:count,evidenceDeadlineMs:amount,finalizedAtMs:count,cancelledAtMs:count,roundSizes:z.array(z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)])).max(16),rounds:z.array(round).max(16),evidence:z.array(evidence).max(1000)}).passthrough().nullable()}).passthrough().parse(result.data);
            if(!sameChainId(dispute.taskId,taskId))throw new MySoAccessError(502,"Dispute reader returned a different task");
            const caseUndrawn=!!dispute.case&&sameChainId(dispute.case.caseId,dispute.caseId)&&Number(dispute.case.subjectKind)===1&&sameChainId(dispute.case.subjectId,taskId)&&Number(dispute.case.state)===2&&Number(dispute.case.currentRound)===0&&dispute.case.rounds.length===0;
            const evidenceOpen=!!dispute.case&&(Number(dispute.case.state)===1&&BigInt(String(dispute.case.evidenceDeadlineMs))>=BigInt(Date.now())||Number(dispute.case.state)===2&&dispute.case.rounds.length===Number(dispute.case.currentRound));
            return Response.json({taskId:dispute.taskId,caseId:dispute.caseId,openedByRole:Number(dispute.openedByRole),state:Number(dispute.state),feeEachMist:String(dispute.feeEachMist),buyerPaidMist:String(dispute.buyerPaidMist),sellerPaidMist:String(dispute.sellerPaidMist),openedAtMs:Number(dispute.openedAtMs),agreementProposer:Number(dispute.agreementProposer),agreementOutcome:dispute.agreementOutcome===null?null:Number(dispute.agreementOutcome),caseUndrawn,case:dispute.case?{state:Number(dispute.case.state),stage:Number(dispute.case.stage),finalOutcome:dispute.case.finalOutcome===null?null:Number(dispute.case.finalOutcome),appealable:dispute.case.appealable,currentRound:Number(dispute.case.currentRound),roundSizes:dispute.case.roundSizes.map(Number),appealsUsed:Number(dispute.case.appealsUsed),failedAppeal:dispute.case.failedAppeal,participants:dispute.case.participants===null?null:String(dispute.case.participants),evidenceDeadlineMs:String(dispute.case.evidenceDeadlineMs),evidenceOpen,finalizedAtMs:dispute.case.finalizedAtMs===null?null:String(dispute.case.finalizedAtMs),cancelledAtMs:dispute.case.cancelledAtMs===null?null:String(dispute.case.cancelledAtMs),evidence:dispute.case.evidence.map(item=>({index:String(item.index),submitter:item.submitter,round:String(item.round),kind:String(item.kind),digest:item.digest,uri:item.uri,submittedAtMs:String(item.submittedAtMs)})),rounds:dispute.case.rounds.map(item=>({round:Number(item.round),acceptDeadlineMs:String(item.acceptDeadlineMs),commitDeadlineMs:item.commitDeadlineMs===null?null:String(item.commitDeadlineMs),revealDeadlineMs:item.revealDeadlineMs===null?null:String(item.revealDeadlineMs),tally:item.tally?.map(String)??null,abstain:item.abstain===null?null:String(item.abstain),revealed:item.revealed===null?null:String(item.revealed),decisive:item.decisive,leading:item.leading===null?null:Number(item.leading),appealDeadlineMs:item.appealDeadlineMs===null?null:String(item.appealDeadlineMs)}))}:null},{headers:NO_CACHE});
        }
        if(action==="task-appeal-dispute"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to appeal a task dispute");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskDisputeAppealSchema.parse(await body(req));
            const [taskResult,disputeResult]=await Promise.all([auth.mcp.callTool("task_get",{id:taskId},req.signal),auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal)]);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"The task dispute is unavailable to this participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const amount=z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]);
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),feeEachMist:amount,case:z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),subjectKind:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),subjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),currentRound:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),roundSizes:z.array(z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)])).max(16),appealable:z.boolean(),rounds:z.array(z.object({round:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),leading:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]).nullable(),appealDeadlineMs:amount.nullable()}).passthrough()).max(16)}).passthrough().nullable()}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const caseInfo=dispute.case;
            const currentRound=caseInfo?Number(caseInfo.currentRound):-1;
            const round=caseInfo?.rounds.find(item=>Number(item.round)===currentRound);
            const provisional=round?.leading===null||round?.leading===undefined?null:Number(round.leading);
            const deadline=round?.appealDeadlineMs==null?0n:BigInt(String(round.appealDeadlineMs));
            const losingRole=provisional===0?1:provisional===1?2:provisional===2?role:0;
            const fee=BigInt(String(dispute.feeEachMist))*2n;
            if(!sameChainId(task.taskId,taskId)||!sameChainId(dispute.taskId,taskId)||task.status!==6||role===0)throw new MySoAccessError(403,"Only a current task participant can appeal this dispute");
            if(Number(dispute.state)!==1||!caseInfo||!sameChainId(caseInfo.caseId,dispute.caseId)||Number(caseInfo.subjectKind)!==1||!sameChainId(caseInfo.subjectId,taskId)||Number(caseInfo.state)!==5||!caseInfo.appealable||currentRound<0||currentRound+1>=caseInfo.roundSizes.length||!round||provisional===null||deadline<=BigInt(Date.now())||fee<=0n||fee>18446744073709551615n||provisional!==2&&losingRole!==role)throw new MySoAccessError(409,"The current jury outcome, deadline, or role does not permit an appeal");
            const result=await auth.mcp.callTool("task_appeal_dispute",{taskId,caseId:dispute.caseId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,feeCoinId:input.feeCoinId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The appeal was rejected by current chain state or action policy");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,caseId:dispute.caseId,round:currentRound,priorOutcome:provisional,feeMist:String(fee)},{headers:NO_CACHE});
        }
        if(action==="task-appeal-dispute-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a task dispute appeal receipt");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const caseId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(query.get("caseId"));
            const priorRound=z.coerce.number().int().nonnegative().max(15).parse(query.get("round"));
            const priorOutcome=z.coerce.number().int().min(0).max(2).parse(query.get("priorOutcome"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Appeal evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.appeal.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,taskId))throw new MySoAccessError(502,"The appeal receipt does not match this task");
            const [taskResult,disputeResult]=await Promise.all([auth.mcp.callTool("task_get",{id:taskId},req.signal),auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal)]);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"Task dispute details are not available yet");
            const task=z.object({buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const dispute=z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),feeEachMist:z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)])}).passthrough().parse(disputeResult.data);
            if(!sameChainId(dispute.caseId,caseId))throw new MySoAccessError(502,"The requested appeal case does not match this task's current dispute");
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            if(role===0)throw new MySoAccessError(403,"Only a task participant can verify this appeal");
            const fee=BigInt(String(dispute.feeEachMist))*2n;
            const feeEvent=receipt.events.some(item=>item.type.endsWith("::agent_task::TaskDisputeFeePaid")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId)&&item.data.role===role&&item.data.kind===2&&String(item.data.amount_mist)===String(fee));
            const appealEvent=receipt.events.some(item=>item.type.endsWith("::jury::CaseAppealed")&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,caseId)&&Number(item.data.round)===priorRound+1&&item.data.prior_outcome===priorOutcome);
            if(receipt.status==="finalized"&&(!feeEvent||!appealEvent))throw new MySoAccessError(502,"No finalized appeal fee and jury event pair matched this case and outcome");
            return Response.json({digest:receipt.digest,taskId,caseId,round:priorRound,priorOutcome,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_appeal_fee_and_case_event":"task_appeal_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-submit-dispute-evidence"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to submit evidence to a task dispute");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskDisputeEvidenceSchema.parse(await body(req));
            let uri:URL;
            try{uri=new URL(input.uri);}catch{throw new MySoAccessError(400,"Evidence must use a publicly readable HTTPS URL");}
            if(uri.protocol!=="https:"||uri.username||uri.password||uri.hash||new TextEncoder().encode(input.uri).length>2048)throw new MySoAccessError(400,"Evidence URI must be a public HTTPS URL without credentials or a fragment");
            const [taskResult,disputeResult]=await Promise.all([auth.mcp.callTool("task_get",{id:taskId},req.signal),auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal)]);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"The task dispute is unavailable to this participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const evidence=z.array(z.object({submitter:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough()).max(1000);
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),case:z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),subjectKind:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),subjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),currentRound:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),evidenceDeadlineMs:z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),rounds:z.array(z.object({round:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)])}).passthrough()).max(16),evidence}).passthrough().nullable()}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const caseInfo=dispute.case;
            const currentRound=caseInfo?Number(caseInfo.currentRound):-1;
            const evidenceOpen=!!caseInfo&&(Number(caseInfo.state)===1&&BigInt(String(caseInfo.evidenceDeadlineMs))>=BigInt(Date.now())||Number(caseInfo.state)===2&&caseInfo.rounds.length===Number(caseInfo.currentRound));
            const submitter=role===1?task.buyerPrincipal:task.sellerPrincipal;
            const partyEvidence=caseInfo?caseInfo.evidence.filter(item=>normalize(item.submitter)===normalize(submitter)).length:0;
            if(!sameChainId(task.taskId,taskId)||!sameChainId(dispute.taskId,taskId)||task.status!==6||role===0)throw new MySoAccessError(403,"Only a current task participant can submit dispute evidence");
            if(!caseInfo||!sameChainId(caseInfo.caseId,dispute.caseId)||Number(caseInfo.subjectKind)!==1||!sameChainId(caseInfo.subjectId,taskId)||!evidenceOpen||partyEvidence>=8)throw new MySoAccessError(409,"The jury evidence window is closed or this party has reached the evidence limit");
            const result=await auth.mcp.callTool("task_dispute_evidence",{taskId,caseId:dispute.caseId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,digestHex:input.digestHex,uri:input.uri,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The evidence submission was rejected by current jury state or action policy");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,caseId:dispute.caseId,digestHex:input.digestHex,uri:input.uri,round:currentRound},{headers:NO_CACHE});
        }
        if(action==="task-submit-dispute-evidence-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify submitted task dispute evidence");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const caseId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).parse(query.get("caseId"));
            const digestHex=z.string().regex(/^[0-9a-f]{64}$/).parse(query.get("digestHex"));
            const uri=z.string().min(1).max(2048).parse(query.get("uri"));
            const round=z.coerce.number().int().nonnegative().max(15).parse(query.get("round"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Dispute evidence receipt is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.submit_evidence.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,taskId))throw new MySoAccessError(502,"The evidence receipt does not match this task");
            const [taskResult,disputeResult]=await Promise.all([auth.mcp.callTool("task_get",{id:taskId},req.signal),auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal)]);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"Task dispute details are not available yet");
            const task=z.object({buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const dispute=z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(disputeResult.data);
            if(!sameChainId(dispute.caseId,caseId))throw new MySoAccessError(502,"The requested case does not match this task's current dispute");
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const submitter=role===1?task.buyerPrincipal:task.sellerPrincipal;
            if(role===0)throw new MySoAccessError(403,"Only a task participant can verify submitted evidence");
            const event=receipt.events.find(item=>{
                const rawDigest=item.data.digest;
                const observedDigest=Array.isArray(rawDigest)?rawDigest.map(byte=>Number.isInteger(byte)&&Number(byte)>=0&&Number(byte)<=255?Number(byte).toString(16).padStart(2,"0"):"").join(""):typeof rawDigest==="string"?rawDigest.replace(/^0x/i,"").toLowerCase():"";
                const rawUri=item.data.uri;
                let observedUri="";
                if(typeof rawUri==="string")observedUri=rawUri;
                else if(Array.isArray(rawUri)&&rawUri.every(byte=>Number.isInteger(byte)&&Number(byte)>=0&&Number(byte)<=255)){try{observedUri=new TextDecoder("utf-8",{fatal:true}).decode(new Uint8Array(rawUri as number[]));}catch{observedUri="";}}
                return item.type.endsWith("::jury::EvidenceSubmitted")&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,caseId)&&typeof item.data.submitter==="string"&&sameChainId(item.data.submitter,submitter)&&Number(item.data.kind)===1&&Number(item.data.round)===round&&observedDigest===digestHex&&observedUri===uri;
            });
            if(receipt.status==="finalized"&&!event)throw new MySoAccessError(502,"No finalized EvidenceSubmitted event matched this participant, case, digest, URI and round");
            return Response.json({digest:receipt.digest,taskId,caseId,digestHex,uri,round,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_dispute_evidence_event":"task_dispute_evidence_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-dispute-agreement"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to update a dispute settlement proposal");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskDisputeAgreementSchema.parse(await body(req));
            const taskResult=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            const disputeResult=await auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"The task dispute is unavailable to this participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),platformId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable()}).passthrough().parse(taskResult.data);
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),agreementProposer:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]),agreementOutcome:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]).nullable()}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const proposer=Number(dispute.agreementProposer);
            if(!sameChainId(task.taskId,taskId)||!sameChainId(dispute.taskId,taskId)||task.status!==6||Number(dispute.state)!==1||role===0)throw new MySoAccessError(403,"Only a current task party can negotiate an open dispute");
            if(input.action==="propose"&&(proposer!==0&&proposer!==role)||input.action==="accept"&&(proposer===0||proposer===role)||input.action==="clear"&&proposer===0)throw new MySoAccessError(409,"The current dispute proposal does not permit this action");
            if(input.action==="accept"&&!task.platformId)throw new MySoAccessError(409,"The deployed platform object is unavailable for settlement");
            const toolName=({propose:"task_propose_dispute_settlement",accept:"task_accept_dispute_settlement",clear:"task_clear_dispute_settlement"} as const)[input.action];
            const parameters=input.action==="propose"?{taskId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,outcome:input.outcome,idempotencyKey:input.idempotencyKey}:input.action==="accept"?{taskId,buyerAccountId:task.buyerMemoryAccountId,sellerAccountId:task.sellerMemoryAccountId,sellerAgentId:task.sellerAgentId,platformObjectId:task.platformId,idempotencyKey:input.idempotencyKey}:{taskId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,idempotencyKey:input.idempotencyKey};
            const result=await auth.mcp.callTool(toolName,parameters,req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The dispute agreement action was rejected by current chain state or action policy");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,caseId:dispute.caseId,action:input.action,outcome:input.action==="propose"?input.outcome:input.action==="accept"?Number(dispute.agreementOutcome):null},{headers:NO_CACHE});
        }
        if(action==="task-dispute-agreement-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a dispute agreement receipt");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(query.get("taskId"));
            const actionType=z.enum(["propose","accept","clear"]).parse(query.get("action"));
            const expectedOutcome=query.has("outcome")?z.coerce.number().int().min(0).max(2).parse(query.get("outcome")):null;
            if((actionType==="propose"||actionType==="accept")&&expectedOutcome===null||actionType==="clear"&&expectedOutcome!==null)throw new MySoAccessError(400,"The dispute agreement receipt query is incomplete");
            const registryAction=({propose:"task.propose_dispute_settlement.v1",accept:"task.accept_dispute_settlement.v1",clear:"task.clear_dispute_settlement.v1"} as const)[actionType];
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Dispute agreement evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.string(),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.registryAction!==registryAction||receipt.taskId&&!sameChainId(receipt.taskId,taskId))throw new MySoAccessError(502,"The dispute agreement receipt does not match the requested task and action");
            const detailResult=await auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal);
            const taskResult=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!detailResult.ok||!taskResult.ok)throw new MySoAccessError(404,"Task dispute details are not available yet");
            const dispute=z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),agreementProposer:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),agreementOutcome:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]).nullable(),resolvedOutcome:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]).nullable(),resolvedSource:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]).nullable()}).passthrough().parse(detailResult.data);
            const task=z.object({buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            if(role===0)throw new MySoAccessError(403,"Only a task participant can verify this dispute agreement");
            let matched=false;
            if(actionType==="propose")matched=receipt.events.some(item=>item.type.endsWith("::agent_task::TaskDisputeSettlementProposed")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId)&&item.data.proposer_role===role&&item.data.outcome===expectedOutcome);
            else if(actionType==="clear")matched=receipt.events.some(item=>item.type.endsWith("::agent_task::TaskDisputeSettlementCleared")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId)&&item.data.cleared_by_role===role);
            else {
                const outcome=dispute.resolvedOutcome===null?null:Number(dispute.resolvedOutcome);
                const resolved=receipt.events.some(item=>item.type.endsWith("::agent_task::TaskDisputeResolved")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId)&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,dispute.caseId)&&item.data.source===2&&item.data.outcome===expectedOutcome&&outcome===expectedOutcome);
                const payout=expectedOutcome===1?receipt.events.some(item=>item.type.endsWith("::agent_task::TaskRefunded")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId)&&item.data.refund_kind===3):receipt.events.some(item=>item.type.endsWith("::agent_task::TaskReceiptSettled")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,taskId));
                matched=Number(dispute.resolvedSource)===2&&resolved&&payout;
            }
            if(receipt.status==="finalized"&&!matched)throw new MySoAccessError(502,"No finalized event matched this participant and dispute agreement");
            return Response.json({digest:receipt.digest,taskId,action:actionType,outcome:expectedOutcome,status:receipt.status,verification:receipt.status==="finalized"?`finalized_task_dispute_${actionType}_event`:"task_dispute_agreement_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-cancel-dispute"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to withdraw an undrawn dispute");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskDisputeCancelSchema.parse(await body(req));
            const taskResult=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            const disputeResult=await auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"The task dispute is unavailable to this participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),openedByRole:z.union([z.number().int().min(1).max(2),z.string().regex(/^[12]$/)]),state:z.union([z.number().int().min(0).max(8),z.string().regex(/^[0-8]$/)]),case:z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),subjectKind:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),subjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),state:z.union([z.number().int(),z.string().regex(/^[0-9]+$/)]),currentRound:z.union([z.number().int().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]),rounds:z.array(z.unknown()).max(16)}).passthrough().nullable()}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const undrawn=!!dispute.case&&sameChainId(dispute.case.caseId,dispute.caseId)&&Number(dispute.case.subjectKind)===1&&sameChainId(dispute.case.subjectId,taskId)&&Number(dispute.case.state)===2&&Number(dispute.case.currentRound)===0&&dispute.case.rounds.length===0;
            if(!sameChainId(task.taskId,taskId)||!sameChainId(dispute.taskId,taskId)||task.status!==6||role===0)throw new MySoAccessError(403,"Only a current task participant can withdraw the dispute");
            if(Number(dispute.state)!==1||Number(dispute.openedByRole)!==role||!undrawn)throw new MySoAccessError(409,"Only the dispute initiator can cancel before jury selection begins");
            const result=await auth.mcp.callTool("task_cancel_dispute",{taskId,caseId:dispute.caseId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The dispute cannot be cancelled in its current chain state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,caseId:dispute.caseId},{headers:NO_CACHE});
        }
        if(action==="task-cancel-dispute-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a dispute cancellation");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(new URL(req.url).searchParams.get("taskId"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Dispute cancellation evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.cancel_dispute.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"The cancellation receipt does not match this task");
            const dispute=await auth.mcp.callTool("task_get_dispute",{id:expectedTaskId},req.signal);
            if(!dispute.ok)throw new MySoAccessError(404,"The dispute record is unavailable");
            const detail=z.object({caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(dispute.data);
            const cancelled=receipt.events.some(item=>item.type.endsWith("::agent_task::TaskDisputeCancelled")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId)&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,detail.caseId));
            const paired=receipt.events.some(item=>item.type.endsWith("::jury::CaseCancelled")&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,detail.caseId));
            if(receipt.status==="finalized"&&(!cancelled||!paired))throw new MySoAccessError(502,"No finalized task cancellation event paired with its jury case matched this transaction");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,caseId:detail.caseId,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_dispute_cancelled_and_jury_case_cancelled":"task_dispute_cancel_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-respond-dispute"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to match a task dispute fee");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskRespondDisputeSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is unavailable to the connected participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const disputeResult=await auth.mcp.callTool("task_get_dispute",{id:taskId},req.signal);
            if(!disputeResult.ok)throw new MySoAccessError(404,"No open task dispute is available");
            const amount=z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)]);
            const dispute=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),caseId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),openedByRole:z.union([z.number().int().min(1).max(2),z.string().regex(/^[12]$/)]),state:z.union([z.number().int().min(0).max(8),z.string().regex(/^[0-8]$/)]),feeEachMist:amount,buyerPaidMist:amount,sellerPaidMist:amount}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            const paid=role===1?BigInt(String(dispute.buyerPaidMist)):role===2?BigInt(String(dispute.sellerPaidMist)):0n;
            const otherPaid=role===1?BigInt(String(dispute.sellerPaidMist)):BigInt(String(dispute.buyerPaidMist));
            if(!sameChainId(task.taskId,taskId)||!sameChainId(dispute.taskId,taskId)||task.status!==6||role===0)throw new MySoAccessError(403,"Only a task participant can respond to this dispute");
            if(Number(dispute.state)!==1||Number(dispute.openedByRole)===role||paid!==0n||otherPaid!==BigInt(String(dispute.feeEachMist)))throw new MySoAccessError(409,"The dispute is no longer open for this party to match the fee");
            const result=await auth.mcp.callTool("task_respond_dispute",{taskId,caseId:dispute.caseId,buyerAccountId:task.buyerMemoryAccountId,sellerAgentId:task.sellerAgentId,feeCoinId:input.feeCoinId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The dispute fee could not be matched; verify the selected agent-owned MYSO coin and current case state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,caseId:dispute.caseId},{headers:NO_CACHE});
        }
        if(action==="task-respond-dispute-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a matched dispute fee");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(new URL(req.url).searchParams.get("taskId"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task dispute evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.respond_dispute.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"Dispute response receipt does not match this task");
            const taskResult=await auth.mcp.callTool("task_get",{id:expectedTaskId},req.signal);
            const disputeResult=await auth.mcp.callTool("task_get_dispute",{id:expectedTaskId},req.signal);
            if(!taskResult.ok||!disputeResult.ok)throw new MySoAccessError(404,"Task dispute details are not available yet");
            const task=z.object({buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(taskResult.data);
            const dispute=z.object({feeEachMist:z.union([z.number().int().safe().nonnegative(),z.string().regex(/^(0|[1-9][0-9]*)$/)])}).passthrough().parse(disputeResult.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const role=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId))?1:normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId)?2:0;
            if(role===0)throw new MySoAccessError(403,"Only a task participant can verify this receipt");
            const event=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskDisputeFeePaid")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId)&&item.data.role===role&&item.data.kind===1&&String(item.data.amount_mist)===String(dispute.feeEachMist));
            if(receipt.status==="finalized"&&!event)throw new MySoAccessError(502,"No finalized TaskDisputeFeePaid event matched the task, party and exact fee");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_dispute_fee_matched_event":"task_dispute_fee_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-open-dispute"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to open a task dispute");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskOpenDisputeSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is unavailable to the connected participant");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const buyerActor=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&normalize(task.buyerMemoryAccountId)===normalize(auth.scope.accountId)&&(!task.buyerAgentId||normalize(task.buyerAgentId)===normalize(auth.scope.agentId));
            const sellerActor=normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerMemoryAccountId)===normalize(auth.scope.accountId)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId);
            if(normalize(task.taskId)!==normalize(taskId)||task.status!==2)throw new MySoAccessError(409,"A dispute can only be opened for a currently delivered task");
            if(!buyerActor&&!sellerActor)throw new MySoAccessError(403,"Only the buyer or assigned seller agent can open this task dispute");
            const result=await auth.mcp.callTool("task_open_dispute",{taskId,buyerAccountId:task.buyerMemoryAccountId,sellerAccountId:task.sellerMemoryAccountId,sellerAgentId:task.sellerAgentId,feeCoinId:input.feeCoinId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The dispute could not be opened; verify the selected agent-owned MYSO coin, live task state, spend cap and jury roster readiness");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId},{headers:NO_CACHE});
        }
        if(action==="task-open-dispute-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a task dispute");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(new URL(req.url).searchParams.get("taskId"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task dispute evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.open_dispute.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(receipt.digest!==digest||receipt.taskId&&!sameChainId(receipt.taskId,expectedTaskId))throw new MySoAccessError(502,"The dispute receipt does not match the requested transaction and task");
            const disputed=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskDisputed")&&typeof item.data.task_id==="string"&&sameChainId(item.data.task_id,expectedTaskId)&&typeof item.data.case_id==="string");
            const caseId=typeof disputed?.data.case_id==="string"?disputed.data.case_id:null;
            const pairedCase=caseId&&receipt.events.some(item=>item.type.endsWith("::jury::CaseOpened")&&typeof item.data.case_id==="string"&&sameChainId(item.data.case_id,caseId)&&item.data.subject_kind===1&&typeof item.data.subject_id==="string"&&sameChainId(item.data.subject_id,expectedTaskId));
            if(receipt.status==="finalized"&&(!disputed||!pairedCase||!caseId))throw new MySoAccessError(502,"No finalized TaskDisputed event paired with its task jury case matched this transaction");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,caseId,status:receipt.status,verification:receipt.status==="finalized"?"finalized_task_disputed_and_jury_case_opened":"task_dispute_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-cancel-offer"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to cancel an offered task");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=z.object({idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict().parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is not available to the connected buyer");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(taskId))throw new MySoAccessError(502,"Task details did not match the requested task");
            if(task.status!==0||normalize(task.buyerPrincipal)!==normalize(auth.scope.owner)||normalize(task.buyerMemoryAccountId)!==normalize(auth.scope.accountId)||task.buyerAgentId!==null&&!sameChainId(task.buyerAgentId,auth.scope.agentId))throw new MySoAccessError(403,"Only the current buyer principal or the assigned buyer agent can cancel an offered task");
            const result=await auth.mcp.callTool("task_cancel_offer",{taskId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Offer cancellation was rejected by current agent policy or on-chain task state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId},{headers:NO_CACHE});
        }
        if(action==="task-cancel-offer-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify task offer cancellation");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const expectedTaskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(new URL(req.url).searchParams.get("taskId"));
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task cancellation evidence is unavailable to this account");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.literal("task.cancel_offer.v1"),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(receipt.digest!==digest||receipt.status==="failed")throw new MySoAccessError(502,"The receipt does not confirm a successful cancellation transaction");
            const event=receipt.events.find(item=>item.type.endsWith("::agent_task::TaskCancelled")&&typeof item.data.task_id==="string"&&normalize(item.data.task_id)===normalize(expectedTaskId)&&item.data.close_kind===0&&typeof item.data.buyer_principal==="string"&&normalize(item.data.buyer_principal)===normalize(auth.scope.owner));
            if(receipt.status==="finalized"&&(!event||!receipt.taskId||normalize(receipt.taskId)!==normalize(expectedTaskId)))throw new MySoAccessError(502,"No finalized buyer-cancellation event matched this task");
            return Response.json({digest:receipt.digest,taskId:expectedTaskId,status:receipt.status,verification:receipt.status==="finalized"?"finalized_buyer_task_cancelled_event":"task_cancel_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-bind-room"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to bind the task’s existing room");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskRoomBindSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is not available to the connected agent");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),roomGroupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable()}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(taskId))throw new MySoAccessError(502,"Task details did not match the requested task");
            const buyerAssigned=normalize(task.buyerPrincipal)===normalize(auth.scope.owner)&&!!task.buyerAgentId&&normalize(task.buyerAgentId)===normalize(auth.scope.agentId);
            const sellerAssigned=normalize(task.sellerPrincipal)===normalize(auth.scope.owner)&&normalize(task.sellerAgentId)===normalize(auth.scope.agentId);
            if(!buyerAssigned&&!sellerAssigned)throw new MySoAccessError(403,"Only an assigned buyer or seller agent can bind this room");
            if(task.status!==0&&task.status!==1)throw new MySoAccessError(409,"A room can only be bound while the task is offered or accepted");
            if(!task.roomGroupId)throw new MySoAccessError(409,"This task has no room object ID; create its room before creating the task offer");
            const result=await auth.mcp.callTool("messaging_bind_room_to_task",{groupId:task.roomGroupId,taskId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Room binding failed; verify that both task principals can read the room and that the group is an agent room");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest,taskId,roomGroupId:task.roomGroupId},{headers:NO_CACHE});
        }
        if(action==="task-deliver"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to deliver an accepted task");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskDeliverSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is not available to the connected agent");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(taskId))throw new MySoAccessError(502,"Task details did not match the requested task");
            if(task.status!==1||normalize(task.sellerPrincipal)!==normalize(auth.scope.owner)||normalize(task.sellerAgentId)!==normalize(auth.scope.agentId))throw new MySoAccessError(403,"Only the assigned seller agent can deliver a currently accepted task");
            const result=await auth.mcp.callTool("task_deliver",{taskId,sellerAgentId:auth.scope.agentId,digestHex:input.digestHex.toLowerCase(),uri:input.uri,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Delivery was rejected by current agent policy, limits, or on-chain task state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest},{headers:NO_CACHE});
        }
        if(action==="task-upload"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to upload an accepted task artifact");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskUploadSchema.parse(await body(req,720*1024));
            const result=await auth.mcp.callTool("task_upload_deliverable",{request:{taskId,contentBase64:input.contentBase64,idempotencyKey:input.idempotencyKey}},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"The artifact upload was rejected by the task state, agent capability, idempotency record, or Cloudflare R2 configuration");
            const uploaded=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),uri:z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{64}\/[0-9a-fA-F]{64}$/),digestHex:z.string().regex(/^[0-9a-f]{64}$/i),contentLength:z.number().int().min(1).max(512*1024),storage:z.literal("cloudflare_r2"),idempotentReplay:z.boolean(),disclosure:z.string().min(1).max(200)}).strict().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(uploaded.taskId)!==normalize(taskId))throw new MySoAccessError(502,"The uploaded artifact response did not match the requested task");
            return Response.json(uploaded,{headers:NO_CACHE});
        }
        if(action==="task-action-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify a task action receipt");
            const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(runId);
            const query=new URL(req.url).searchParams;
            const expected=taskDeliverSchema.pick({digestHex:true,uri:true}).parse({digestHex:query.get("digestHex"),uri:query.get("uri")});
            const result=await auth.mcp.callTool("task_get_receipt",{id:digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task action evidence is unavailable to this account and agent");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.string(),taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).nullable().optional(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),events:z.array(z.object({type:z.string(),data:z.record(z.string(),z.unknown())})).max(128)}).passthrough().parse(result.data);
            if(receipt.digest!==digest||receipt.registryAction!=="task.deliver.v1"||!receipt.taskId)throw new MySoAccessError(502,"The task receipt does not identify a delivery action");
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const event=receipt.events.find(item=>item.type.includes("::agent_task::TaskDelivered")&&typeof item.data.task_id==="string"&&normalize(item.data.task_id as string)===normalize(receipt.taskId!)&&typeof item.data.seller_agent_id==="string"&&normalize(item.data.seller_agent_id as string)===normalize(auth.scope.agentId)&&item.data.deliverable_digest!==undefined&&item.data.deliverable_uri!==undefined);
            const rawDigest=event?.data.deliverable_digest;
            const eventDigest=Array.isArray(rawDigest)&&rawDigest.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)?rawDigest.map(byte=>Number(byte).toString(16).padStart(2,"0")).join(""):typeof rawDigest==="string"?rawDigest.replace(/^0x/i,"").toLowerCase():null;
            const eventUri=typeof event?.data.deliverable_uri==="string"?event.data.deliverable_uri:null;
            if(receipt.status==="finalized"&&(!event||eventDigest!==expected.digestHex.toLowerCase()||eventUri!==expected.uri))throw new MySoAccessError(502,"No finalized TaskDelivered event matched the expected artifact digest and URI");
            return Response.json({digest:receipt.digest,taskId:receipt.taskId,status:receipt.status,uri:eventUri,digestHex:eventDigest,verification:receipt.status==="finalized"?"finalized_task_delivered_event":"task_action_receipt_not_finalized"},{headers:NO_CACHE});
        }
        if(action==="task-settle"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to settle a delivered task");
            const taskId=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const input=taskSettleSchema.parse(await body(req));
            const read=await auth.mcp.callTool("task_get",{id:taskId},req.signal);
            if(!read.ok)throw new MySoAccessError(404,"This task is not available to the connected agent");
            const task=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int(),buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),platformId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable()}).passthrough().parse(read.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(taskId))throw new MySoAccessError(502,"Task details did not match the requested task");
            if(task.status!==2||normalize(task.buyerPrincipal)!==normalize(auth.scope.owner)||!task.buyerAgentId||normalize(task.buyerAgentId)!==normalize(auth.scope.agentId))throw new MySoAccessError(403,"Only the assigned buyer agent can settle a currently delivered task");
            if(!task.platformId)throw new MySoAccessError(409,"This task has no indexed platform object for settlement");
            const result=await auth.mcp.callTool("task_settle",{taskId,sellerAccountId:task.sellerMemoryAccountId,platformObjectId:task.platformId,idempotencyKey:input.idempotencyKey},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Settlement was rejected by current agent policy, limits, or on-chain task state");
            const submitted=z.object({digest:z.string().min(1).max(128)}).passthrough().parse(result.data);
            return Response.json({submitted:true,transactionDigest:submitted.digest},{headers:NO_CACHE});
        }
        if(action==="task-detail"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to read a task");
            const id=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get",{id},req.signal);
            if(!result.ok)throw new MySoAccessError(404,"Task details are unavailable to this account");
            const task=z.object({
                taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),title:z.string().min(1).max(200),status:z.number().int().min(0).max(6),roomGroupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),
                buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),buyerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),scopeDigest:z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),amountMist:z.string().regex(/^(0|[1-9][0-9]*)$/),
                sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerMemoryAccountId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),platformId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),
                platformFeeBps:z.number().int().min(0).max(10000),ecosystemFeeBps:z.number().int().min(0).max(10000),
                createdAtMs:z.number().int().safe().nonnegative(),acceptDeadlineMs:z.number().int().safe().nonnegative(),acceptedAtMs:z.number().int().safe().nonnegative().nullable(),
                deliveryDeadlineMs:z.number().int().safe().nonnegative().nullable(),deliveredAtMs:z.number().int().safe().nonnegative().nullable(),
                settleDeadlineMs:z.number().int().safe().nonnegative().nullable(),settledAtMs:z.number().int().safe().nonnegative().nullable(),reviewDeadlineMs:z.number().int().safe().nonnegative().nullable(),
                refundProposer:z.union([z.number().int().min(0).max(2),z.string().regex(/^[0-2]$/)]),refundProposedAtMs:z.number().int().safe().nonnegative().nullable(),
                transactionId:z.string().min(1).max(128),reviews:z.array(z.object({raterRole:z.number().int(),stars:z.number().int().min(1).max(5),reviewedAtMs:z.number().int().safe().nonnegative(),transactionId:z.string().min(1).max(128)}).passthrough()).max(2),
            }).passthrough().parse(result.data);
            const normalize=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            if(normalize(task.taskId)!==normalize(id))throw new MySoAccessError(502,"Task details did not match the requested task");
            const taskUrl=new URL(req.url);
            const historyLimit=z.coerce.number().int().min(1).max(100).parse(taskUrl.searchParams.get("historyLimit")??50);
            const historyOffset=z.coerce.number().int().min(0).max(100000).parse(taskUrl.searchParams.get("historyOffset")??0);
            const historyResult=await auth.mcp.callTool("task_get_lifecycle_history",{id,limit:historyLimit,offset:historyOffset},req.signal);
            if(!historyResult.ok)throw new MySoAccessError(502,"Task lifecycle history is unavailable from the configured MCP service");
            const history=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),events:z.array(z.object({eventType:z.string().min(1).max(100),occurredAtMs:z.number().int().safe().nonnegative(),sourceEventId:z.string().min(1).max(160),status:z.number().int().min(0).max(6).nullable(),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).optional(),verification:z.enum(["indexer_preview","fullnode_unavailable","fullnode_mismatch","finalized_fullnode_task_event","checkpoint_pending_task_event","failed_task_transaction","fullnode_event_mismatch","fullnode_unavailable_or_unknown"]),checkpoint:z.string().nullable().optional()}).passthrough()).max(100),limit:z.number().int().min(1).max(100),offset:z.number().int().min(0).max(100000),nextOffset:z.number().int().min(1).max(100100).nullable(),evidenceSource:z.literal("participant_indexed_history_with_fullnode_event_checks")}).passthrough().parse(historyResult.data);
            if(normalize(history.taskId)!==normalize(task.taskId)||history.offset!==historyOffset)throw new MySoAccessError(502,"Task history did not match the requested task page");
            return Response.json({taskId:task.taskId,title:task.title,status:task.status,roomGroupId:task.roomGroupId,buyerPrincipal:task.buyerPrincipal,buyerAgentId:task.buyerAgentId,buyerMemoryAccountId:task.buyerMemoryAccountId,scopeDigestHex:task.scopeDigest,amountMist:task.amountMist,sellerPrincipal:task.sellerPrincipal,sellerAgentId:task.sellerAgentId,sellerMemoryAccountId:task.sellerMemoryAccountId,platformId:task.platformId,platformFeeBps:task.platformFeeBps,ecosystemFeeBps:task.ecosystemFeeBps,createdAtMs:task.createdAtMs,acceptDeadlineMs:task.acceptDeadlineMs,acceptedAtMs:task.acceptedAtMs,deliveryDeadlineMs:task.deliveryDeadlineMs,deliveredAtMs:task.deliveredAtMs,settleDeadlineMs:task.settleDeadlineMs,settledAtMs:task.settledAtMs,reviewDeadlineMs:task.reviewDeadlineMs,refundProposer:Number(task.refundProposer),refundProposedAtMs:task.refundProposedAtMs,transactionId:task.transactionId,reviews:task.reviews.map(review=>({raterRole:review.raterRole,stars:review.stars,reviewedAtMs:review.reviewedAtMs,transactionId:review.transactionId})),history:history.events,historyEvidence:history.evidenceSource,historyOffset:history.offset,historyLimit:history.limit,nextHistoryOffset:history.nextOffset},{headers:NO_CACHE});
        }
        if(action==="task-settlement-receipt"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to verify task settlement");
            const id=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get_settlement_receipt",{id},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Task settlement evidence is unavailable to this account");
            const notSettled=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),settled:z.literal(false),status:z.number().int().min(0).max(6),receipt:z.null(),verification:z.literal("task_not_indexed_as_settled")}).strict();
            const settled=z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),settled:z.literal(true),status:z.literal(3),receipt:z.object({taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),receiptId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),transactionId:z.string().min(1).max(128),settledAtMs:z.number().int().safe().nonnegative()}).passthrough(),transactionDigest:z.string().min(1).max(128),verification:z.literal("finalized_fullnode_task_receipt_settled_event")}).passthrough();
            const normalizeId=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
            const parsed=notSettled.safeParse(result.data);
            if(parsed.success){if(normalizeId(parsed.data.taskId)!==normalizeId(id))throw new MySoAccessError(502,"Settlement evidence did not match the requested task");return Response.json(parsed.data,{headers:NO_CACHE});}
            const verified=settled.safeParse(result.data);if(!verified.success||normalizeId(verified.data.taskId)!==normalizeId(id)||normalizeId(verified.data.receipt.taskId)!==normalizeId(verified.data.taskId)||verified.data.receipt.transactionId!==verified.data.transactionDigest)throw new MySoAccessError(502,"The fullnode task receipt did not match this task");
            return Response.json({taskId:verified.data.taskId,settled:true,status:3,receipt:{taskId:verified.data.receipt.taskId,receiptId:verified.data.receipt.receiptId,transactionId:verified.data.receipt.transactionId,settledAtMs:verified.data.receipt.settledAtMs},transactionDigest:verified.data.transactionDigest,verification:verified.data.verification},{headers:NO_CACHE});
        }
        if(action==="task-deliverable"){
            if(req.method!=="GET")throw new MySoAccessError(405,"Use GET to retrieve a delivered task artifact");
            const id=z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/).parse(runId);
            const result=await auth.mcp.callTool("task_get_deliverable",{id},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"This task artifact is unavailable to the connected account");
            const artifact=z.object({
                taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),
                uri:z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{64}\/[0-9a-fA-F]{64}$/),
                digestHex:z.string().regex(/^[0-9a-f]{64}$/i),
                contentBase64:z.string().max(700000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
                contentLength:z.number().int().min(0).max(512*1024),
                encoding:z.literal("base64"),
                digestVerified:z.literal(true),
                verification:z.string().min(1).max(100),
                disclosure:z.string().min(1).max(300),
            }).strict().parse(result.data);
            return Response.json(artifact,{headers:NO_CACHE});
        }
        if(action==="catalog"){
            const [tools,models]=await Promise.all([auth.mcp.listTools(),auth.mcp.callTool("ai_list_models",{})]);
            if(!models.ok)throw new MySoAccessError(502,"The MySo model list is unavailable");
            return Response.json({tools:tools.filter(t=>!t.name.startsWith("work_run_")&&t.name!=="ai_chat"),...catalogSchema.parse(models.data)},{headers:NO_CACHE});
        }
        if(action==="runs"){
            if(req.method==="POST"){
                const input=createSchema.parse(await body(req));
                if(input.taskId){
                    const result=await auth.mcp.callTool("task_get",{id:input.taskId},req.signal);
                    if(!result.ok)throw new MySoAccessError(403,"This task is unavailable to the connected account");
                    const task=z.object({
                        taskId:z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),status:z.number().int().min(0).max(6),
                        buyerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),buyerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),
                        sellerPrincipal:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),sellerAgentId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
                    }).passthrough().parse(result.data);
                    const normalizeId=(value:string)=>value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
                    const sameId=(left:string,right:string)=>normalizeId(left)===normalizeId(right);
                    const buyer= sameId(task.buyerPrincipal,auth.scope.owner)&&(!task.buyerAgentId||sameId(task.buyerAgentId,auth.scope.agentId));
                    const seller=sameId(task.sellerPrincipal,auth.scope.owner)&&sameId(task.sellerAgentId,auth.scope.agentId);
                    const buyerCanCoordinate=buyer&&(task.status===0||task.status===1);const sellerCanCoordinate=seller&&task.status===1;
                    if(normalizeId(task.taskId)!==normalizeId(input.taskId)||(!buyerCanCoordinate&&!sellerCanCoordinate))
                        throw new MySoAccessError(403,"A buyer can coordinate an open or accepted task; the assigned seller agent can coordinate only after acceptance");
                }
                return Response.json(await store.create(auth.scope,input.id,input.plan,input.taskId),{status:201,headers:NO_CACHE});
            }
            const query=new URL(req.url).searchParams;
            const limit=z.coerce.number().int().min(1).max(200).parse(query.get("limit")??20);
            const offset=z.coerce.number().int().min(0).max(100000).parse(query.get("offset")??0);
            const result=await auth.mcp.callTool("work_run_list",{limit,offset});
            if(!result.ok)throw new MySoAccessError(502,"Your work runs are unavailable");
            return Response.json(result.data,{headers:NO_CACHE});
        }
        z.uuid().parse(runId);const id=runId!;
        if(action==="run-task-history-refresh"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to refresh linked task history");
            const refreshed=await store.refreshTaskHistory(auth.scope,id);
            return Response.json(refreshed,{headers:NO_CACHE});
        }
        if(action==="cancel-run"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to cancel a work run");
            const input=z.object({confirmed:z.literal(true)}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("work_run_cancel",{runId:id,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"This run could not be cancelled; review its current status and any unresolved operation");
            return Response.json(z.object({runId:z.uuid(),status:z.string(),cancelRequested:z.boolean(),cancelRequestedAt:z.string().nullable(),alreadyTerminal:z.boolean(),reconciliationRequired:z.boolean()}).strict().parse(result.data),{headers:NO_CACHE});
        }
        if(action==="complete-run"){
            if(req.method!=="POST")throw new MySoAccessError(405,"Use POST to complete a work run");
            const input=z.object({confirmed:z.literal(true)}).strict().parse(await body(req));
            const result=await auth.mcp.callTool("work_run_complete",{runId:id,request:input},req.signal);
            if(!result.ok)throw new MySoAccessError(409,"Every plan step must have verified durable evidence and all work must be reconciled before completion");
            const completed=await store.get(auth.scope,id);
            if(!completed||completed.id!==id||completed.status!=="completed")throw new MySoAccessError(502,"The work service did not confirm run completion");
            return Response.json(completed,{headers:NO_CACHE});
        }
        const run=await store.get(auth.scope,id);if(!run)throw new MySoAccessError(404,"Work run unavailable");
        if(action==="run")return Response.json(await attachMarketplaceTask(run,auth.mcp),{headers:NO_CACHE});
        if(action==="run-operation-receipt"){
            const operationId=z.uuid().parse(new URL(req.url).searchParams.get("operationId"));
            if(req.method!=="GET"&&req.method!=="POST")throw new MySoAccessError(405,"Use GET to inspect or POST to resolve a verified work-operation receipt");
            let offset=0;let operation:Record<string,unknown>|undefined;let complete=false;
            for(let pageNo=0;pageNo<50;pageNo++){
                const result=await auth.mcp.callTool("work_run_list_operations",{runId:id,limit:200,offset},req.signal);
                if(!result.ok)throw new MySoAccessError(502,"The work-run journal is unavailable");
                const page=z.object({operations:z.array(z.object({id:z.uuid(),runId:z.uuid(),toolCallId:z.string(),toolName:z.string(),inputHash:z.string().regex(/^[0-9a-f]{64}$/),idempotencyKey:z.string().min(8).max(128),status:z.enum(["pending","succeeded","failed","reconciling"])}).passthrough()),hasNext:z.boolean(),nextOffset:z.number().int().nonnegative().nullable()}).strict().parse(result.data);
                operation=page.operations.find(item=>item.id===operationId);
                if(operation){complete=true;break;}
                if(!page.hasNext){complete=true;break;}
                if(page.nextOffset===null||page.nextOffset<=offset)throw new MySoAccessError(502,"The work-run journal returned an invalid cursor");
                offset=page.nextOffset;
            }
            if(!complete)throw new MySoAccessError(502,"The work-run journal did not reach the requested operation within its bounded search");
            if(!operation)throw new MySoAccessError(404,"Operation is outside this work run");
            if(req.method==="POST"){
                const requestBody=await body(req,operation.toolName==="task_upload_deliverable"?740*1024:128*1024);
                if(operation.toolName==="task_upload_deliverable"){
                    const retryInput=z.object({contentBase64:z.string().min(4).max(700000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict().safeParse(requestBody);
                    if(!retryInput.success)z.object({confirmed:z.literal(true)}).strict().parse(requestBody);
                    let recovered=await auth.mcp.callTool("work_run_reconcile_task_upload",{runId:id,request:{operationId}},req.signal);
                    if(!recovered.ok)throw new MySoAccessError(409,"The task upload remains held because its upload ledger and R2 object could not be verified");
                    let upload=z.object({resolved:z.boolean(),status:z.string(),taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),uri:z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{1,64}\/[0-9a-f]{64}$/).optional(),digestHex:z.string().regex(/^[0-9a-f]{64}$/).optional(),contentLength:z.number().int().positive().max(512*1024).optional(),verification:z.string().optional(),reason:z.string().optional(),retry:z.object({taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),idempotencyKey:z.string().min(8).max(128),digestHex:z.string().regex(/^[0-9a-f]{64}$/)}).optional()}).strict().parse(recovered.data);
                    if(retryInput.success){
                        const retry=upload.retry;
                        if(!retry||!run.taskId||!sameChainId(retry.taskId,run.taskId)||!sameChainId(retry.taskId,upload.taskId??retry.taskId)||! ["no_upload_ledger_record","r2_object_not_yet_available"].includes(upload.reason??""))throw new MySoAccessError(409,"This upload is not eligible for exact-file recovery; verify its saved R2 outcome first");
                        const bytes=Buffer.from(retryInput.data.contentBase64,"base64");
                        if(!bytes.length||bytes.length>512*1024||bytes.toString("base64")!==retryInput.data.contentBase64||createHash("sha256").update(bytes).digest("hex")!==retry.digestHex)throw new MySoAccessError(400,"Selected file bytes do not match the exact saved upload digest");
                        const retried=await auth.mcp.callTool("task_upload_deliverable",{request:{taskId:retry.taskId,contentBase64:retryInput.data.contentBase64,idempotencyKey:retry.idempotencyKey}},req.signal);
                        if(!retried.ok)throw new MySoAccessError(409,"The exact-file retry was rejected; the operation remains held for verification");
                        recovered=await auth.mcp.callTool("work_run_reconcile_task_upload",{runId:id,request:{operationId}},req.signal);
                        if(!recovered.ok)throw new MySoAccessError(409,"The upload retry returned, but the participant ledger and R2 bytes could not be verified");
                        upload=z.object({resolved:z.boolean(),status:z.string(),taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),uri:z.string().regex(/^r2:\/\/0x[0-9a-fA-F]{1,64}\/[0-9a-f]{64}$/).optional(),digestHex:z.string().regex(/^[0-9a-f]{64}$/).optional(),contentLength:z.number().int().positive().max(512*1024).optional(),verification:z.string().optional(),reason:z.string().optional(),retry:z.object({taskId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),idempotencyKey:z.string().min(8).max(128),digestHex:z.string().regex(/^[0-9a-f]{64}$/)}).optional()}).strict().parse(recovered.data);
                    }
                    if(!upload.resolved||!upload.taskId||!upload.uri||!upload.digestHex||!upload.contentLength)return Response.json({runId:id,operationId,chainAction:null,receipt:null,recoveredUpload:null,retry:upload.retry,verification:upload.reason??upload.status},{status:202,headers:NO_CACHE});
                    const uriOwner=upload.uri.split("/")[2];
                    if(!run.taskId||!sameChainId(upload.taskId,run.taskId)||!uriOwner||!sameChainId(uriOwner,auth.scope.owner)||upload.verification!=="participant_upload_ledger_and_r2_bytes"&&upload.verification!=="previously_verified_upload")throw new MySoAccessError(502,"The recovered R2 artifact does not match this run, owner or verification source");
                    return Response.json({runId:id,operationId,chainAction:null,receipt:null,recoveredUpload:{taskId:upload.taskId,uri:upload.uri,digestHex:upload.digestHex,contentLength:upload.contentLength,verification:upload.verification??"participant_upload_ledger_and_r2_bytes"},verification:upload.verification??"participant_upload_ledger_and_r2_bytes"},{headers:NO_CACHE});
                }
                const recovered=await auth.mcp.callTool("work_run_reconcile_action_receipt",{runId:id,request:{operationId}},req.signal);
                if(!recovered.ok)throw new MySoAccessError(409,"The operation remains held because its exact registered action receipt could not be verified");
                const outcome=z.object({resolved:z.boolean(),status:z.string(),digest:z.string().optional(),registryAction:z.string().optional(),parameterHash:z.string().optional(),verification:z.string().optional(),reason:z.string().optional()}).strict().parse(recovered.data);
                if(!outcome.resolved||!outcome.digest||!outcome.registryAction)return Response.json({runId:id,operationId,chainAction:null,receipt:null,recoveredUpload:null,verification:outcome.reason??outcome.status},{status:202,headers:NO_CACHE});
                const receiptResult=await auth.mcp.callTool("chain_get_action_receipt",{id:outcome.digest},req.signal);
                if(!receiptResult.ok)throw new MySoAccessError(502,"The configured fullnode could not return the verified action receipt");
                const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.string(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),checkpoint:z.union([z.string(),z.number().int().safe()]).nullable().optional(),events:z.array(z.object({type:z.string().min(1).max(512)}).passthrough()).max(1000),evidenceSource:z.string().max(160)}).passthrough().parse(receiptResult.data);
                if(receipt.digest!==outcome.digest||receipt.registryAction!==outcome.registryAction||receipt.evidenceSource!=="configured_fullnode_and_scoped_preparation")throw new MySoAccessError(502,"The receipt did not match the journaled registered action");
                return Response.json({runId:id,operationId,chainAction:{registryAction:outcome.registryAction,status:outcome.status,parameterHash:outcome.parameterHash??"",digest:outcome.digest},receipt:{digest:receipt.digest,status:receipt.status,checkpoint:receipt.checkpoint??null,eventTypes:receipt.events.map(event=>event.type)},recoveredUpload:null,verification:outcome.verification??receipt.evidenceSource},{headers:NO_CACHE});
            }
            if(operation.toolName==="task_upload_deliverable")return Response.json({runId:id,operationId,chainAction:null,receipt:null,recoveredUpload:null,verification:"task_upload_uses_participant_ledger_and_r2_recovery"},{headers:NO_CACHE});
            if(operation.status==="failed")return Response.json({runId:id,operationId,chainAction:null,receipt:null,verification:"operation_has_a_terminal_failure"},{headers:NO_CACHE});
            const actionResult=await auth.mcp.callTool("chain_find_action_by_idempotency_key",{idempotency_key:operation.idempotencyKey},req.signal);
            if(!actionResult.ok)return Response.json({runId:id,operationId,chainAction:null,receipt:null,verification:"no_registered_action_for_operation_key"},{headers:NO_CACHE});
            const actionRow=z.object({idempotencyKey:z.string(),registryAction:z.string(),registryVersion:z.string(),accountId:z.string(),agentId:z.string(),status:z.enum(["preparing","sponsored","submitting","executed","failed"]),digest:z.string().nullable(),parameterHash:z.string(),expiresAtMs:z.number().int().safe().positive(),evidenceSource:z.literal("authenticated_chain_action_journal")}).strict().parse(actionResult.data);
            if(actionRow.idempotencyKey!==operation.idempotencyKey||!sameChainId(actionRow.accountId,auth.scope.accountId)||!sameChainId(actionRow.agentId,auth.scope.agentId))throw new MySoAccessError(502,"The prepared chain action does not match this work operation scope");
            if(!actionRow.digest)return Response.json({runId:id,operationId,chainAction:{registryAction:actionRow.registryAction,status:actionRow.status,parameterHash:actionRow.parameterHash},receipt:null,verification:"registered_action_has_no_transaction_digest"},{headers:NO_CACHE});
            const receiptResult=await auth.mcp.callTool("chain_get_action_receipt",{id:actionRow.digest},req.signal);
            if(!receiptResult.ok)throw new MySoAccessError(502,"The configured fullnode could not verify the prepared action receipt");
            const receipt=z.object({digest:z.string().min(1).max(128),registryAction:z.string(),status:z.enum(["finalized","checkpoint_pending","failed","unknown"]),checkpoint:z.union([z.string(),z.number().int().safe()]).nullable().optional(),events:z.array(z.object({type:z.string().min(1).max(512)}).passthrough()).max(1000),evidenceSource:z.string().max(160)}).passthrough().parse(receiptResult.data);
            if(receipt.digest!==actionRow.digest||receipt.registryAction!==actionRow.registryAction||receipt.evidenceSource!=="configured_fullnode_and_scoped_preparation")throw new MySoAccessError(502,"The receipt did not match the scoped prepared action");
            return Response.json({runId:id,operationId,chainAction:{registryAction:actionRow.registryAction,status:actionRow.status,parameterHash:actionRow.parameterHash,digest:actionRow.digest},receipt:{digest:receipt.digest,status:receipt.status,checkpoint:receipt.checkpoint??null,eventTypes:receipt.events.map(event=>event.type)},verification:receipt.evidenceSource},{headers:NO_CACHE});
        }
        if(action==="run-operations"){
            let offset=0;let complete=false;let scanned=0;
            const unresolved:Array<{id:string;toolName:string;toolCallId:string;inputHash:string;idempotencyKey:string;status:"pending"|"reconciling";maxAmountMist?:string;stepId?:string;error?:string}> = [];
            for(let pageNo=0;pageNo<50;pageNo++){
                const result=await auth.mcp.callTool("work_run_list_operations",{runId:id,limit:200,offset},req.signal);
                if(!result.ok)throw new MySoAccessError(502,"The work-run recovery journal is unavailable");
                const page=z.object({operations:z.array(z.object({id:z.uuid(),toolName:z.string().min(1).max(100),toolCallId:z.string().min(1).max(200),inputHash:z.string().regex(/^[0-9a-f]{64}$/),idempotencyKey:z.string().min(8).max(128),status:z.enum(["pending","succeeded","failed","reconciling"]),maxAmountMist:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),stepId:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),error:z.string().max(2000).optional()})).max(200),hasNext:z.boolean(),nextOffset:z.number().int().nonnegative().nullable()}).strict().parse(result.data);
                scanned+=page.operations.length;if(scanned>10000)throw new MySoAccessError(502,"The recovery journal exceeds its bounded review limit");
                for(const operation of page.operations)if(operation.status==="pending"||operation.status==="reconciling")unresolved.push({...operation,status:operation.status as "pending"|"reconciling"});
                if(!page.hasNext){complete=true;break;}
                if(page.nextOffset===null||page.nextOffset<=offset)throw new MySoAccessError(502,"The recovery journal returned an invalid cursor");
                offset=page.nextOffset;
            }
            if(!complete)throw new MySoAccessError(502,"The recovery journal did not reach its end within the review bound");
            return Response.json({runId:id,operations:unresolved,complete:true,verification:"scoped_encrypted_work_operation_journal"},{headers:NO_CACHE});
        }
        if(action==="run-ai-usage"){
            const totals=new Map<string,{spent:bigint;unresolved:number;operations:number}>();
            const actionTotals=new Map<string,{spent:bigint;reserved:bigint;operations:number}>();
            const bucket=(stepId:string)=>{const current=totals.get(stepId)??{spent:0n,unresolved:0,operations:0};totals.set(stepId,current);return current;};
            const actionBucket=(stepId:string)=>{const current=actionTotals.get(stepId)??{spent:0n,reserved:0n,operations:0};actionTotals.set(stepId,current);return current;};
            const budgetedActions=new Set(["access_purchase_mydata_access","access_purchase_post_access","task_create","spt_buy"]);
            let offset=0;let complete=false;let scanned=0;
            for(let pageNo=0;pageNo<50;pageNo++){
                const result=await auth.mcp.callTool("work_run_list_operations",{runId:id,limit:200,offset},req.signal);
                if(!result.ok)throw new MySoAccessError(502,"Work-run AI usage is unavailable");
                const page=z.object({operations:z.array(z.object({toolName:z.string(),stepId:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),status:z.enum(["pending","succeeded","failed","reconciling"]),maxAmountMist:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),result:z.unknown().optional()})),hasNext:z.boolean(),nextOffset:z.number().int().nonnegative().nullable()}).strict().parse(result.data);
                scanned+=page.operations.length;if(scanned>10000)throw new MySoAccessError(502,"Work-run AI usage history exceeds its bounded audit limit");
                for(const operation of page.operations){
                    if(operation.toolName!=="ai_chat"&&!budgetedActions.has(operation.toolName))continue;
                    const isAction=operation.toolName!=="ai_chat";
                    if(isAction){
                        const usage=actionBucket(operation.stepId??"");usage.operations++;
                        if(operation.status==="succeeded"){
                            if(operation.maxAmountMist===undefined)throw new MySoAccessError(502,"A completed MYSO action has no exact reserved amount");
                            usage.spent+=BigInt(operation.maxAmountMist);
                        }else if(operation.status==="pending"||operation.status==="reconciling")usage.reserved+=BigInt(operation.maxAmountMist??"0");
                    }else{
                        const usage=bucket(operation.stepId??"");usage.operations++;
                        if(operation.status==="succeeded"){
                            const amount=operation.result&&typeof operation.result==="object"?(operation.result as Record<string,unknown>).amount_mist:undefined;
                            if(typeof amount!=="string"||!/^(0|[1-9][0-9]*)$/.test(amount))throw new MySoAccessError(502,"A completed AI operation has no exact MIST charge");
                            usage.spent+=BigInt(amount);
                        }else if(operation.status==="pending"||operation.status==="reconciling")usage.unresolved++;
                    }
                }
                if(!page.hasNext){complete=true;break;}
                if(page.nextOffset===null||page.nextOffset<=offset)throw new MySoAccessError(502,"Work-run AI usage pagination did not advance");
                offset=page.nextOffset;
            }
            if(!complete)throw new MySoAccessError(502,"Work-run AI usage history did not reach its end within the page bound");
            const steps=run.plan.steps.map(step=>{const usage=totals.get(step.id)??{spent:0n,unresolved:0,operations:0};return {stepId:step.id,title:step.title,spentMist:usage.spent.toString(),unresolved:usage.unresolved,operations:usage.operations};});
            const actionSteps=run.plan.steps.map(step=>{const usage=actionTotals.get(step.id)??{spent:0n,reserved:0n,operations:0};return {stepId:step.id,title:step.title,spentMist:usage.spent.toString(),reservedMist:usage.reserved.toString(),operations:usage.operations};});
            const coordination=totals.get("")??{spent:0n,unresolved:0,operations:0};
            return Response.json({runId:id,steps,coordination:{spentMist:coordination.spent.toString(),unresolved:coordination.unresolved,operations:coordination.operations},actionSteps},{headers:NO_CACHE});
        }
        const rawTurn=await body(req);
        let input=workerBinding
            ? (()=>{const options=workerTurnSchema.parse(rawTurn);return {...options,input:run.plan.goal,allowedTools:[]} as z.infer<typeof turnSchema>;})()
            : turnSchema.parse(rawTurn);
        if(workerBinding){
            const workerContext=await auth.mcp.callTool("agent_get_context",{});
            if(!workerContext.ok||!workerContext.data||typeof workerContext.data!=="object")throw new MySoAccessError(403,"The run worker context is unavailable");
            const context=workerContext.data as Record<string,unknown>;
            input={...input,allowPrivateGraph:context.allowPrivateGraph===true,allowRoomHistory:context.allowRoomHistory===true,allowPrivateTaskArtifacts:context.allowPrivateTaskArtifacts===true,allowPrivateContentSharing:context.allowPrivateContentSharing===true};
        }
        if(input.continueRun&&!workerBinding)throw new MySoAccessError(403,"Only a durable action_worker dispatch can continue a yielded harness slice");
        if(input.continueRun&&!(run.messages?.length))throw new MySoAccessError(409,"A yielded harness continuation requires a saved transcript");
        const models=await auth.mcp.callTool("ai_list_models",{});
        if(!models.ok)throw new MySoAccessError(502,"MySo model discovery is unavailable");
        const selected=catalogSchema.parse(models.data).models.find(m=>m.id===input.modelId);
        if(!selected?.supports_tools || !selected.context_length || !selected.max_output_tokens)throw new MySoAccessError(400,"Choose a MySo model with confirmed tool support and output limits");
        if(input.maxOutputTokens>selected.max_output_tokens)throw new MySoAccessError(400,"Output limit exceeds this model's supported limit");
        const availableTools=await auth.mcp.listTools();
        const available=new Map(availableTools.map(t=>[t.name,t]));
        if(workerBinding){
            input={...input,allowedTools:availableTools.map(tool=>tool.name).filter(name=>name!=="ai_chat"&&!isHostedWorkToolForbidden(name)&&!name.startsWith("work_run_")&&!/^(agent_(provision|register|update|deactivate|revoke)|organization_(define|assign|revoke)|chain_(approve|submit_approved|prepare_approved))/.test(name)&&(!HOSTED_WORK_PRIVATE_GRAPH_TOOLS.has(name)||input.allowPrivateGraph)&&(!HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS.has(name)||input.allowPrivateTaskArtifacts)&&(!HOSTED_WORK_ROOM_CONTENT_TOOLS.has(name)||input.allowRoomHistory)&&((input.allowPrivateContentSharing)||!requiresHostedPrivateContentSharingConsent(name,available.get(name)?.readOnly??false)))};
        }
        if(input.allowedTools.some(t=>!available.has(t)||t==="ai_chat"||isHostedWorkToolForbidden(t)||t.startsWith("work_run_")||/^(agent_(provision|register|update|deactivate|revoke)|organization_(define|assign|revoke)|chain_(approve|submit_approved|prepare_approved))/.test(t)))throw new MySoAccessError(403,"One or more tools are unavailable, private-content or message-mutation tools are excluded from hosted work, or the action requires the account management interface");
        if(input.allowedTools.some(name=>HOSTED_WORK_ROOM_CONTENT_TOOLS.has(name))&&!input.allowRoomHistory)throw new MySoAccessError(403,"Room messages and attachment plaintext require explicit consent for this work run");
        if(input.allowedTools.some(t=>HOSTED_WORK_PRIVATE_GRAPH_TOOLS.has(t))&&!input.allowPrivateGraph)throw new MySoAccessError(403,"Private graph access requires explicit consent for this work run");
        if(input.allowedTools.some(t=>HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS.has(t))&&!input.allowPrivateTaskArtifacts)throw new MySoAccessError(403,"Private task artifact access requires explicit consent for this work run");
        const privateContextAllowed=input.allowRoomHistory||input.allowPrivateGraph||input.allowPrivateTaskArtifacts;
        if(input.allowPrivateContentSharing&&!privateContextAllowed)throw new MySoAccessError(400,"Private-content sharing consent requires consent for at least one private content source");
        if(privateContextAllowed&&!input.allowPrivateContentSharing&&input.allowedTools.some(name=>{
            const tool=available.get(name);
            return tool!==undefined&&requiresHostedPrivateContentSharingConsent(tool.name,tool.readOnly);
        }))throw new MySoAccessError(403,"Tools that may send private context to another service require separate per-run sharing consent");
        // Recover only from the durable operation journal. Uncertain operations stay blocked;
        // missing reservations prove a write tool was never dispatched by remoteTool.
        let messages=(run.messages??[]) as AgentMessage[];
        if(transcriptContainsHostedWorkForbiddenTool(messages))throw new MySoAccessError(409,"This run contains private-content tool history and cannot be resumed through hosted inference. Continue in a new run without private graph or decrypted room content.");
        const redactedPrivateContext=redactPrivateContextTail(messages);
        messages=redactedPrivateContext.messages;
        const pending=new Map<string,{name:string;arguments:Record<string,unknown>}>();
        for(const message of messages){
            if(message.role==="assistant")for(const part of message.content)if(part.type==="toolCall")pending.set(part.id,{name:part.name,arguments:part.arguments});
            if(message.role==="toolResult")pending.delete(message.toolCallId);
        }
        const journal=new Map<string,{id:string;toolCallId:string;toolName:string;inputHash:string;idempotencyKey:string;status:"pending"|"succeeded"|"failed"|"reconciling";result?:unknown;error?:string|null}>();
        if(pending.size){
            let offset=0;let hasNext=true;const found=new Set<string>();
            while(hasNext&&found.size<pending.size){
                const result=await auth.mcp.callTool("work_run_list_operations",{runId:id,limit:200,offset});
                if(!result.ok)throw new MySoAccessError(502,"The saved operation journal is unavailable for safe recovery");
                const page=z.object({operations:z.array(z.object({id:z.uuid(),runId:z.uuid(),toolCallId:z.string(),toolName:z.string(),inputHash:z.string().regex(/^[0-9a-f]{64}$/),idempotencyKey:z.string(),status:z.enum(["pending","succeeded","failed","reconciling"]),result:z.unknown().optional(),error:z.string().nullable().optional(),acquired:z.boolean()})),hasNext:z.boolean(),nextOffset:z.number().int().nonnegative().nullable()}).parse(result.data);
                for(const operation of page.operations)if(pending.has(operation.toolCallId)){journal.set(operation.toolCallId,operation);found.add(operation.toolCallId);}
                hasNext=page.hasNext;offset=page.nextOffset??offset;
                if(hasNext&&page.nextOffset===null)throw new MySoAccessError(502,"The saved operation journal returned an invalid cursor");
            }
            for(const [toolCallId,call] of pending){
                const operation=journal.get(toolCallId);
                if(operation&&(operation.toolName!==call.name||operation.inputHash!==workOperationInputHash(call.name,call.arguments)))
                    throw new MySoAccessError(409,"A saved tool call does not match its journal identity; this run remains held for review");
                if(call.name==="task_upload_deliverable"&&!operation&&!((call.arguments.request as Record<string,unknown>|undefined)?.contentBase64))
                    throw new MySoAccessError(409,"This task upload was checkpointed without its file bytes and has no durable reservation. Select the file again before retrying.");
                if(operation&&(operation.status==="pending"||operation.status==="reconciling"))
                    throw new MySoAccessError(409,"A saved tool action has an uncertain outcome. Resolve its exact action receipt before continuing");
                if(operation?.status==="succeeded"&&operation.result===undefined)
                    throw new MySoAccessError(409,"A completed tool operation has no saved result; this run remains held for review");
                if(call.name==="ask_user_question")throw new MySoAccessError(409,"This run is waiting for the owner's answer to a saved question");
            }
        }
        // Credential rotation must not change the durable turn identity: retries bind to the
        // same worker/run/turn input while the bearer remains short-lived and replaceable.
        const hashPayload=workerBinding?{worker:{keyRef:workerBinding.keyRef,accountId:workerBinding.accountId,parentAgentId:workerBinding.parentAgentId,workerAgentId:workerBinding.workerAgentId,runId:workerBinding.runId},turn:input}:input;
        const hash=createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex");
        const lease=await store.acquireTurn(id,input.requestId,hash,run.revision);
        if(!lease.acquired){
            if(workerBinding&&lease.status==="yielded")return Response.json({turnId:lease.id,status:"yielded",replayed:true},{headers:NO_CACHE});
            return Response.json({turnId:lease.id,status:lease.status,replayed:true},{status:lease.status==="finished"?200:lease.status==="running"?202:409,headers:{...NO_CACHE,"Retry-After":"5"}});
        }
        const owned=lease.store;
        // Purge previously fetched private plaintext before recovery or sending any
        // messages back to a hosted model. A later private read must go through the
        // normal live MyData or room permission check again.
        if(redactedPrivateContext.redacted)await owned.checkpoint(id,messages);
        if(pending.size){
            const recovered:AgentMessage[]=[];
            const current=await owned.get(auth.scope,id);
            if(!current)throw new MySoAccessError(404,"Work run unavailable during transcript recovery");
            for(const message of messages){
                recovered.push(message);
                if(message.role!=="assistant")continue;
                for(const call of message.content){
                    if(call.type!=="toolCall"||!pending.has(call.id))continue;
                    const operation=journal.get(call.id);
                    let result:unknown;
                    let isError=false;
                    if(!operation){
                        const args=call.arguments as Record<string,unknown>;
                        if(call.name==="ask_user_question"){
                            result={status:"waiting_for_input"};
                        }else if(call.name==="get_run_state"){
                            result=current;
                        }else if(call.name==="plan_work"&&args.plan&&typeof args.plan==="object"&&canonicalRecoveryInput(current.plan)===canonicalRecoveryInput(args.plan)){
                            result=current;
                        }else if(call.name==="set_work_step"&&typeof args.stepId==="string"&&current.stepStatus[args.stepId]===args.status&&canonicalRecoveryInput(current.stepEvidence?.[args.stepId]??[])===canonicalRecoveryInput(args.evidenceIds??[])){
                            result=current;
                        }else{
                            const definition=availableTools.find(tool=>tool.name===call.name);
                            if(!definition)throw new MySoAccessError(409,"An interrupted local tool call cannot be reconstructed safely; this run remains held for review");
                            result={ok:false,error:{code:"WORK_CALL_RESULT_UNSAVED",message:definition.readOnly?"The read result was not saved. Repeat the read if its current value is still needed.":"The work journal has no reservation, so this remote write was not dispatched. Call it again if still needed."}};
                            isError=true;
                        }
                    }else if(operation.status==="failed"){
                        result=operation.result??{ok:false,error:{code:"WORK_OPERATION_FAILED",message:operation.error??"The saved operation failed"}};
                        isError=true;
                    }else{
                        result=operation.result;
                        const envelope=result&&typeof result==="object"?result as Record<string,unknown>:{};
                        isError=envelope.ok!==true;
                        if(envelope.ok===true&&call.name==="task_upload_deliverable"){
                            const artifact=await owned.appendTaskArtifact(auth.scope,id,operation.id);
                            result={...envelope,data:{upload:envelope.data,workArtifact:artifact,workOperationId:operation.id}};
                        }else if(envelope.ok===true&&recoveryTransactionDigest(result)){
                            const receipt=await owned.appendActionReceipt(auth.scope,id,operation.id);
                            result={...envelope,data:recoveryResultData(envelope.data,{workOperationId:operation.id,workReceipt:receipt})};
                            isError=receipt.verification!=="verified";
                        }else if(envelope.ok===true){
                            result={...envelope,data:recoveryResultData(envelope.data,{workOperationId:operation.id})};
                        }
                    }
                    const mapped=toToolResult(result);
                    const details=z.json().safeParse(mapped.details);
                    recovered.push({role:"toolResult",toolCallId:call.id,toolName:call.name,content:mapped.content,...(details.success?{details:details.data}:{}),isError,timestamp:Date.now()});
                }
            }
            messages=recovered;
            await owned.checkpoint(id,messages);
        }
        const model:Model<"myso-ai-credit">={id:selected.id,name:selected.display_name,api:"myso-ai-credit",provider:"myso",baseUrl:process.env.MYSO_AGENTS_MCP_URL!,input:["text"],reasoning:false,contextWindow:selected.context_length,maxTokens:input.maxOutputTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
        let agent:Awaited<ReturnType<typeof createWorkCoordinator>>|undefined;
        let modelTurnLimitReached=false;
        let timer:ReturnType<typeof setInterval>|undefined;
        let renewal:Promise<void>=Promise.resolve();
        const stop=()=>agent?.abort();
        req.signal.addEventListener("abort",stop,{once:true});
        try{
            agent=await createWorkCoordinator({scope:auth.scope,runId:id,store:owned,mcp:auth.mcp,engine:createMySoEngine({scope:auth.scope,runId:id,store:owned,mcp:auth.mcp,model}),messages,allowedTools:new Set(input.allowedTools),allowPrivateContentSharing:input.allowPrivateContentSharing,allowPrivateGraph:input.allowPrivateGraph,allowPrivateTaskArtifacts:input.allowPrivateTaskArtifacts,maxModelTurns:input.maxModelTurns,onModelTurnLimit:()=>{modelTurnLimitReached=true;}});
            let leaseLost=false;
            timer=setInterval(()=>{
                renewal=renewal.then(async()=>{if(!await owned.renewTurn(id)){leaseLost=true;stop();}}).catch(()=>{leaseLost=true;stop();});
            },30000);
            // Installed pi awaits subscribers: fail closed on checkpoint errors before executing later tools.
            agent.subscribe(async(event)=>{
                if(leaseLost)throw new Error("Turn lease lost");
                if(event.type==="message_end")await owned.checkpoint(id,durableWorkTranscript(agent!.state.messages));
            });
            if(req.signal.aborted)throw new Error("Request was cancelled");
            if(input.continueRun)await agent.continue();else await agent.prompt(input.input);
            await renewal;
            if(leaseLost)throw new Error("Turn lease lost");
            const asked=agent.state.messages.some((m,index)=>index>=messages.length&&m.role==="assistant"&&m.content.some(p=>p.type==="toolCall"&&p.name==="ask_user_question"));
            const approval=agent.state.messages.slice(messages.length).some(m=>m.role==="toolResult" && m.isError && !!(m.details as {error?:{approvalRequired?:boolean}}|undefined)?.error?.approvalRequired);
            const failed=!!agent.state.errorMessage||agent.state.messages.at(-1)?.role==="assistant"&&["error","aborted"].includes((agent.state.messages.at(-1) as {stopReason:string}).stopReason);
            const disposition=approval?"waiting_for_approval":failed?"failed":asked?"waiting_for_input":workerBinding&&modelTurnLimitReached?"yielded":"idle";
            await owned.finishTurn(id,lease.id,durableWorkTranscript(agent.state.messages),disposition);
            let finishedRun=await owned.get(auth.scope,id);
            // Scheduled action-worker runs have no browser to press Complete. The
            // durable service remains authoritative and refuses completion until
            // steps have evidence and every journaled operation has settled.
            if(workerBinding&&disposition==="idle"&&finishedRun?.status==="running"&&finishedRun.plan.steps.length>0&&finishedRun.plan.steps.every(step=>finishedRun!.stepStatus[step.id]==="succeeded")){
                try{finishedRun=await owned.complete(auth.scope,id);}catch{finishedRun=await owned.get(auth.scope,id);}
            }
            if(disposition==="yielded"&&finishedRun?.status==="yielded")return Response.json({turnId:lease.id,status:"yielded"},{headers:NO_CACHE});
            return Response.json({turnId:lease.id,turnStatus:disposition,run:await attachMarketplaceTask(finishedRun,auth.mcp)},{headers:NO_CACHE});
        }catch{
            try{await owned.finishTurn(id,lease.id,durableWorkTranscript(agent?.state.messages??messages),"failed");}catch{/* Pending journal and expired fence hold this run; never retry side effects here. */}
            throw new MySoAccessError(409,"This turn could not finish. Review its saved state and spending before continuing");
        }finally{if(timer)clearInterval(timer);req.signal.removeEventListener("abort",stop);await renewal;}
    }catch(error){
        if(error instanceof z.ZodError)return Response.json({error:"Request does not match the supported work format"},{status:400,headers:NO_CACHE});
        return mySoErrorResponse(error);
    }
}

/** Bridge the browser messaging SDK's encrypted storage adapter to the scoped MCP/R2 path. */
export async function handleMySoRoomAttachment(req:Request,operation:"upload"|"download"):Promise<Response>{
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for room attachment transfer");
        const auth=await authenticatedMySo(req);
        const input=operation==="upload"
            ? z.object({groupId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),contentBase64:z.string().min(4).max(6990508).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),idempotencyKey:z.string().uuid().optional()}).strict().parse(await body(req,7*1024*1024+8192))
            : z.object({storageId:z.string().regex(/^r2room:\/\/(0x)?[0-9a-fA-F]{1,64}\/[0-9a-fA-F-]{36}$/)}).strict().parse(await body(req,16*1024));
        const result=operation==="upload"
            ? await auth.mcp.callTool("messaging_upload_room_attachment",{request:input},req.signal)
            : await auth.mcp.callTool("messaging_download_room_attachment",{request:input},req.signal);
        if(!result.ok)throw new MySoAccessError(403,operation==="upload"?"The connected agent cannot upload to this room":"The connected agent cannot currently read this room attachment");
        if(operation==="upload"){
            const data=roomAttachmentUploadSchema.parse(result.data);
            const storageRef=/^r2room:\/\/(0x[0-9a-fA-F]{1,64})\/([0-9a-fA-F-]{36})$/.exec(data.storageId);
            if(!sameChainId(data.groupId,(input as {groupId:string}).groupId)||!storageRef||!sameChainId(storageRef[1]!,data.groupId))throw new MySoAccessError(502,"The uploaded attachment reference does not match the selected room");
            return Response.json(data,{headers:NO_CACHE});
        }
        const data=roomAttachmentDownloadSchema.parse(result.data);
        const requested=(input as {storageId:string}).storageId.match(/^r2room:\/\/(0x[0-9a-fA-F]{1,64})\/([0-9a-fA-F-]{36})$/);
        const returned=data.storageId.match(/^r2room:\/\/(0x[0-9a-fA-F]{1,64})\/([0-9a-fA-F-]{36})$/);
        if(!requested||!returned||!sameChainId(requested[1]!,returned[1]!)||requested[2]!.toLowerCase()!==returned[2]!.toLowerCase())throw new MySoAccessError(502,"The downloaded attachment reference does not match the requested object");
        const bytes=Buffer.from(data.contentBase64,"base64");
        if(bytes.length!==data.contentLength||bytes.toString("base64")!==data.contentBase64||createHash("sha256").update(bytes).digest("hex")!==data.sha256Hex)throw new MySoAccessError(502,"The encrypted attachment failed its length or digest check");
        return Response.json(data,{headers:NO_CACHE});
    }catch(error){return mySoErrorResponse(error);}
}
