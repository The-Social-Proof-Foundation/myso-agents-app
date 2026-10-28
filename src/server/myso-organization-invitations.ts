import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const inputSchema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("list"),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(100000).default(0)}).strict(),
    z.object({operation:z.literal("respond"),organizationId:id,decision:z.enum(["accept","decline"]),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/)}).strict(),
    z.object({operation:z.literal("receipt"),organizationId:id,decision:z.enum(["accept","decline"]),digest}).strict(),
]);
const actionIds={accept:"organization.accept_invitation.v1",decline:"organization.decline_invitation.v1"} as const;
const unwrap=(result:{ok:boolean;data?:unknown},message:string)=>{if(!result.ok)throw new MySoAccessError(409,message);return result.data;};
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
async function receipt(auth:Awaited<ReturnType<typeof authenticatedMySo>>,organizationId:string,decision:"accept"|"decline",txDigest:string,signal:AbortSignal){
    const value=unwrap(await auth.mcp.callTool("chain_get_action_receipt",{id:txDigest},signal),"Invitation action receipt is not available yet");
    const result=z.object({digest,registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"]),events:z.array(z.unknown()),evidenceSource:z.string()}).passthrough().parse(value);
    if(result.digest!==txDigest||result.registryAction!==actionIds[decision]||(["finalized","executed"].includes(result.status)&&result.events.length!==1))throw new MySoAccessError(502,"Invitation receipt did not match the exact action");
    return result;
}
export async function handleMySoOrganizationInvitations(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for organization invitation actions");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Invitation request is not valid JSON");}
        const input=inputSchema.parse(raw);
        if(input.operation==="list"){
            const value=unwrap(await auth.mcp.callTool("organization_list_my_invitations",{limit:input.limit,offset:input.offset},req.signal),"Pending invitations could not be loaded");
            const parsed=z.object({invitations:z.array(z.unknown()),evidence:z.literal("bounded_pending_invitee_indexer_preview")}).passthrough().parse(value);
            return Response.json(parsed,{headers:HEADERS});
        }
        if(input.operation==="respond"){
            const organization=unwrap(await auth.mcp.callTool("organization_get",{id:input.organizationId},req.signal),"Organization details are not available yet");
            const metadata=z.object({organization_id:id.optional(),organizationId:id.optional(),account_id:id.optional(),accountId:id.optional()}).passthrough().parse(organization);
            const returnedId=metadata.organization_id??metadata.organizationId;
            const organizationAccountId=metadata.account_id??metadata.accountId;
            if(!returnedId||!same(returnedId,input.organizationId)||!organizationAccountId)throw new MySoAccessError(502,"Organization metadata did not identify its current account binding");
            const tool=input.decision==="accept"?"organization_accept_invitation":"organization_decline_invitation";
            const action=unwrap(await auth.mcp.callTool(tool,{organizationAccountId,organizationId:input.organizationId,invitee:auth.derivedAddress,idempotencyKey:input.idempotencyKey},req.signal),"The authenticated agent could not submit this invitation response");
            const submission=z.object({digest:digest.optional(),transactionDigest:digest.optional()}).passthrough().parse(action);
            const txDigest=submission.digest??submission.transactionDigest;
            if(!txDigest)throw new MySoAccessError(502,"Invitation action did not return its transaction digest");
            const verified=await receipt(auth,input.organizationId,input.decision,txDigest,req.signal);
            return Response.json({organizationId:input.organizationId,decision:input.decision,...verified},{headers:HEADERS});
        }
        const verified=await receipt(auth,input.organizationId,input.decision,input.digest,req.signal);
        return Response.json({organizationId:input.organizationId,decision:input.decision,...verified},{headers:HEADERS});
    }catch(error){if(error instanceof z.ZodError)return Response.json({error:"Organization invitation request has an unsupported format"},{status:400,headers:HEADERS});return mySoErrorResponse(error);}
}
