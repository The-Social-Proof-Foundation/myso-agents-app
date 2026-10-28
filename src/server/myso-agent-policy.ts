import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const ACTIONS={
    revoke:"agent.revoke_agent.v1",
    grant_capability:"agent.grant_capability.v1",
    revoke_capability:"agent.revoke_capability.v1",
    raise_spending_limit:"agent.raise_spending_limit.v1",
    lower_spending_limit:"agent.lower_spending_limit.v1",
} as const;
const REQUEST_TOOLS={revoke:"agent_admin_request_revoke",grant_capability:"agent_admin_request_grant_capability",revoke_capability:"agent_admin_request_revoke_capability",raise_spending_limit:"agent_admin_request_raise_spending_limit",lower_spending_limit:"agent_admin_request_lower_spending_limit"} as const;
type PolicyAction=keyof typeof ACTIONS;
const idSchema=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const decimalSchema=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value=>BigInt(value)<=18446744073709551615n);
const keySchema=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const sameId=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
async function body(req:Request){
    if(!req.headers.get("content-type")?.includes("application/json")||!req.body)throw new MySoAccessError(415,"Send a JSON request");
    const reader=req.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>16*1024)throw new MySoAccessError(413,"Agent policy request is too large");chunks.push(next.value);}}
    finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new MySoAccessError(400,"Agent policy request is not valid JSON");}
}
async function quote(auth:Awaited<ReturnType<typeof authenticatedMySo>>,agentObjectId:string,signal?:AbortSignal){
    const result=await auth.mcp.callTool("agent_admin_get_quote",{id:agentObjectId},signal);
    if(!result.ok)throw new MySoAccessError(403,"This agent's current policy is unavailable to the connected account");
    const value=z.object({
        agent:z.object({agentObjectId:idSchema,expectedDerivedAddress:idSchema,expectedPlatformScope:z.string().min(1).max(80),expectedCapabilities:decimalSchema,expectedLimitMist:z.union([decimalSchema,z.literal("unlimited")]),active:z.boolean(),effectiveAuthority:z.object({computed:z.literal(true),activeNow:z.boolean(),evidenceSource:z.literal("configured_fullnode_live_object_snapshot")}).passthrough()}).passthrough(),
        supportedGrantMask:decimalSchema,writesEnabled:z.boolean(),authority:z.literal("owner_wallet"),evidenceSource:z.literal("configured_fullnode"),
    }).passthrough().parse(result.data);
    if(!sameId(value.agent.agentObjectId,agentObjectId))throw new MySoAccessError(502,"The live policy quote did not match the requested agent");
    if(!value.writesEnabled)throw new MySoAccessError(403,"Owner agent policy changes are disabled for this deployment");
    return value;
}
function parameters(action:PolicyAction,agentObjectId:string,policy:Awaited<ReturnType<typeof quote>>,input:{capabilityMask?:string;newLimitMist?:string;confirmed?:boolean}){
    const agent=policy.agent;
    const identity={agentObjectId:agent.agentObjectId,expectedDerivedAddress:agent.expectedDerivedAddress,expectedPlatformScope:agent.expectedPlatformScope};
    if(action==="revoke"){
        if(input.confirmed!==true)throw new MySoAccessError(400,"Explicit confirmation is required for permanent agent revocation");
        return identity;
    }
    if(action==="grant_capability"||action==="revoke_capability"){
        const mask=decimalSchema.parse(input.capabilityMask);const current=BigInt(agent.expectedCapabilities);const requested=BigInt(mask);const supported=BigInt(policy.supportedGrantMask);
        if(requested===0n||(requested&supported)!==requested)throw new MySoAccessError(400,"Choose one or more capabilities supported by the deployed MySo contract");
        if(action==="grant_capability"&&(current&requested)!==0n)throw new MySoAccessError(409,"The selected capability is already present; refresh the policy before changing it");
        if(action==="revoke_capability"&&(current&requested)!==requested)throw new MySoAccessError(409,"The selected capability is not currently granted; refresh the policy before changing it");
        return {...identity,expectedCapabilities:agent.expectedCapabilities,capabilityMask:mask};
    }
    if(action==="raise_spending_limit"){
        if(agent.expectedLimitMist==="unlimited")throw new MySoAccessError(409,"This agent already has an unlimited per-action limit");
        const next=input.newLimitMist==="unlimited"?"unlimited":decimalSchema.parse(input.newLimitMist);
        if(next!=="unlimited"&&BigInt(next)<=BigInt(agent.expectedLimitMist))throw new MySoAccessError(400,"The new per-action limit must exceed the current limit");
        return {...identity,expectedLimitMist:agent.expectedLimitMist,newLimitMist:next};
    }
    const next=decimalSchema.parse(input.newLimitMist);
    if(agent.expectedLimitMist!=="unlimited"&&BigInt(next)>=BigInt(agent.expectedLimitMist))throw new MySoAccessError(400,"The new per-action limit must be lower than the current limit");
    return {...identity,expectedLimitMist:agent.expectedLimitMist,newLimitMist:next};
}
const requestSchema=z.object({operation:z.literal("request"),agentObjectId:idSchema,action:z.enum(Object.keys(ACTIONS) as [PolicyAction,...PolicyAction[]]),idempotencyKey:keySchema,capabilityMask:decimalSchema.optional(),newLimitMist:z.union([decimalSchema,z.literal("unlimited")]).optional(),confirmed:z.boolean().optional()}).strict();
const approvedSchema=z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict();
const prepareSchema=z.object({operation:z.literal("prepare"),agentObjectId:idSchema,action:z.enum(Object.keys(ACTIONS) as [PolicyAction,...PolicyAction[]]),idempotencyKey:keySchema,approvalId:z.uuid(),capabilityMask:decimalSchema.optional(),newLimitMist:z.union([decimalSchema,z.literal("unlimited")]).optional(),confirmed:z.boolean().optional()}).strict();
const submitSchema=z.object({operation:z.literal("submit"),action:z.enum(Object.keys(ACTIONS) as [PolicyAction,...PolicyAction[]]),idempotencyKey:keySchema,approvalId:z.uuid(),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),walletSignature:z.string().min(1).max(4096)}).strict();
const receiptSchema=z.object({operation:z.literal("receipt"),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),action:z.enum(Object.keys(ACTIONS) as [PolicyAction,...PolicyAction[]])}).strict();
export async function handleMySoAgentPolicy(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for agent policy approval steps");
        const auth=await authenticatedMySo(req);const raw=await body(req);
        if(raw&&typeof raw==="object"&&"operation" in raw){
            const operation=(raw as {operation:unknown}).operation;
            if(operation==="request"){
                const input=requestSchema.parse(raw);const policy=await quote(auth,input.agentObjectId,req.signal);
                const parametersForAction=parameters(input.action,input.agentObjectId,policy,input);
                const registryAction=ACTIONS[input.action];
                const result=await auth.mcp.callTool(REQUEST_TOOLS[input.action],{...parametersForAction,idempotencyKey:input.idempotencyKey,expiresInSeconds:600},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The exact owner approval request could not be created");
                const approval=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional(),expiresAtMs:z.number().optional(),expires_at_ms:z.number().optional()}).passthrough().parse(result.data);
                const approvalId=approval.approvalId??approval.approval_id;const approvalIntent=approval.approvalIntent??approval.approval_intent;
                if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"The approval response omitted its signed intent");
                return Response.json({approvalId,approvalIntent,expiresAtMs:approval.expiresAtMs??approval.expires_at_ms,registryAction,parameters:parametersForAction,idempotencyKey:input.idempotencyKey},{headers:HEADERS});
            }
            if(operation==="approve"){
                const input=approvedSchema.parse(raw);const result=await auth.mcp.callTool("chain_approve_action",{approvalId:input.approvalId,walletSignature:input.walletSignature},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The owner signature was not accepted for this exact agent policy change");
                return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});
            }
            if(operation==="prepare"){
                const input=prepareSchema.parse(raw);const policy=await quote(auth,input.agentObjectId,req.signal);
                const parametersForAction=parameters(input.action,input.agentObjectId,policy,input);const registryAction=ACTIONS[input.action];
                const result=await auth.mcp.callTool("chain_prepare_approved_action",{registryAction,parameters:parametersForAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The approved policy change is stale or could not be prepared");
                const prepared=z.object({bytes:z.string().min(1),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),expiresAtMs:z.number().optional(),expires_at_ms:z.number().optional()}).passthrough().parse(result.data);
                return Response.json({approvalId:input.approvalId,registryAction,parameters:parametersForAction,idempotencyKey:input.idempotencyKey,bytes:prepared.bytes,digest:prepared.digest,expiresAtMs:prepared.expiresAtMs??prepared.expires_at_ms},{headers:HEADERS});
            }
            if(operation==="submit"){
                const input=submitSchema.parse(raw);const registryAction=ACTIONS[input.action];
                const result=await auth.mcp.callTool("chain_submit_approved_action",{registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The signed policy transaction was not accepted; check the same digest before retrying");
                return Response.json({submitted:true,digest:input.digest,registryAction,result:result.data},{headers:HEADERS});
            }
            if(operation==="receipt"){
                const input=receiptSchema.parse(raw);const result=await auth.mcp.callTool("agent_admin_get_receipt",{id:input.digest},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The finalized owner-policy receipt is not available yet");
                const receipt=z.object({digest:z.string(),registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"]),evidence:z.array(z.unknown()),evidenceSource:z.string()}).passthrough().parse(result.data);
                if(receipt.digest!==input.digest||receipt.registryAction!==ACTIONS[input.action]||(["finalized","executed"].includes(receipt.status)&&receipt.evidence.length!==1))throw new MySoAccessError(502,"The fullnode evidence did not match this exact agent policy change");
                return Response.json(receipt,{headers:HEADERS});
            }
        }
        throw new MySoAccessError(400,"Unsupported agent policy operation");
    }catch(error){
        if(error instanceof z.ZodError)return Response.json({error:"The agent policy request or response had an unsupported format"},{status:400,headers:HEADERS});
        return mySoErrorResponse(error);
    }
}
