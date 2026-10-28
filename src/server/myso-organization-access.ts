import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const decimal=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value=>BigInt(value)<=18446744073709551615n);
const key=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const actionSchema=z.discriminatedUnion("action",[
    z.object({action:z.literal("define_role"),organizationId:id,roleName:z.string().trim().min(1).max(256),permissionsMask:decimal}).strict(),
    z.object({action:z.literal("assign_role"),organizationId:id,memberAddress:id,roleName:z.string().trim().min(1).max(256)}).strict(),
    z.object({action:z.literal("revoke_role"),organizationId:id,memberAddress:id,roleName:z.string().trim().min(1).max(256)}).strict(),
    z.object({action:z.literal("create_invitation"),organizationId:id,invitee:id,roleName:z.string().trim().min(1).max(256).optional(),permissionsMask:decimal,expiresAtMs:decimal.optional()}).strict().superRefine((value,ctx)=>{
        if(!value.roleName&&value.permissionsMask==="0")ctx.addIssue({code:"custom",message:"An invitation needs a role or a nonzero permission mask"});
    }),
]);
const requestSchema=z.object({operation:z.literal("request"),action:z.enum(["define_role","assign_role","revoke_role","create_invitation"]),parameters:z.unknown(),idempotencyKey:key}).strict();
const inputSchema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("read"),organizationId:id}).strict(),
    requestSchema,
    z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict(),
    z.object({operation:z.literal("prepare"),action:z.enum(["define_role","assign_role","revoke_role","create_invitation"]),parameters:z.unknown(),idempotencyKey:key,approvalId:z.uuid()}).strict(),
    z.object({operation:z.literal("submit"),action:z.enum(["define_role","assign_role","revoke_role","create_invitation"]),idempotencyKey:key,approvalId:z.uuid(),digest,walletSignature:z.string().min(1).max(4096)}).strict(),
    z.object({operation:z.literal("receipt"),digest,action:z.enum(["define_role","assign_role","revoke_role","create_invitation"])}).strict(),
]);
const actionTools={define_role:"organization_define_role",assign_role:"organization_assign_role",revoke_role:"organization_revoke_role",create_invitation:"organization_create_invitation"} as const;
const actionIds={define_role:"organization.define_role.v1",assign_role:"organization.assign_role.v1",revoke_role:"organization.revoke_role.v1",create_invitation:"organization.create_invitation.v1"} as const;
const unwrap=(result:{ok:boolean;data?:unknown},message:string)=>{if(!result.ok)throw new MySoAccessError(409,message);return result.data;};
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
function parseActionParameters(action:"define_role"|"assign_role"|"revoke_role"|"create_invitation",raw:unknown){
    const record=z.record(z.string(),z.unknown()).parse(raw);
    return actionSchema.parse({...record,action});
}
function requireScopedOrganization(auth:Awaited<ReturnType<typeof authenticatedMySo>>,organizationId:string){
    if(!auth.scope.organizationId||!same(auth.scope.organizationId,organizationId))throw new MySoAccessError(403,"Organization role management is limited to the connected agent's authenticated organization");
}
export async function handleMySoOrganizationAccess(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for organization role and invitation management");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Organization access request is not valid JSON");}
        const input=inputSchema.parse(raw);
        if(input.operation==="read"){
            requireScopedOrganization(auth,input.organizationId);
            const [roles,assignments,invitations]=await Promise.all([
                auth.mcp.callTool("organization_list_roles",{limit:100,offset:0},req.signal),
                auth.mcp.callTool("organization_list_role_assignments",{limit:100,offset:0},req.signal),
                auth.mcp.callTool("organization_list_invitations",{limit:100,offset:0},req.signal),
            ]);
            return Response.json({organizationId:input.organizationId,roles:unwrap(roles,"Organization roles are unavailable to this owner/admin"),assignments:unwrap(assignments,"Organization assignments are unavailable to this owner/admin"),invitations:unwrap(invitations,"Organization invitations are unavailable to this owner/admin"),evidence:"bounded_indexer_preview"},{headers:HEADERS});
        }
        if(input.operation==="request"){
            const parameters=parseActionParameters(input.action,input.parameters);
            requireScopedOrganization(auth,parameters.organizationId);
            const registryAction=actionIds[input.action];
            const approval=unwrap(await auth.mcp.callTool(actionTools[input.action],{...parameters,idempotencyKey:input.idempotencyKey,expiresInSeconds:600},req.signal),"Organization action approval could not be created");
            const value=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional()}).passthrough().parse(approval);
            const approvalId=value.approvalId??value.approval_id;const approvalIntent=value.approvalIntent??value.approval_intent;
            if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"Organization action approval omitted its signed owner intent");
            return Response.json({action:input.action,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId,approvalIntent},{headers:HEADERS});
        }
        if(input.operation==="approve"){
            unwrap(await auth.mcp.callTool("chain_approve_action",{approvalId:input.approvalId,walletSignature:input.walletSignature},req.signal),"Owner wallet signature was not accepted");
            return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});
        }
        if(input.operation==="prepare"){
            const parameters=parseActionParameters(input.action,input.parameters);
            requireScopedOrganization(auth,parameters.organizationId);
            const registryAction=actionIds[input.action];
            const prepared=z.object({bytes:z.string().min(1),digest}).passthrough().parse(unwrap(await auth.mcp.callTool("chain_prepare_approved_action",{registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},req.signal),"The owner-approved organization transaction could not be prepared"));
            return Response.json({action:input.action,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,...prepared},{headers:HEADERS});
        }
        if(input.operation==="submit"){
            const registryAction=actionIds[input.action];
            unwrap(await auth.mcp.callTool("chain_submit_approved_action",{registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},req.signal),"The signed organization transaction was not accepted");
            return Response.json({submitted:true,digest:input.digest,registryAction},{headers:HEADERS});
        }
        const result=z.object({digest:z.string(),registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"]),events:z.array(z.unknown()),evidenceSource:z.string()}).passthrough().parse(unwrap(await auth.mcp.callTool("chain_get_action_receipt",{id:input.digest},req.signal),"Organization action receipt is not available yet"));
        if(result.digest!==input.digest||result.registryAction!==actionIds[input.action]||(["finalized","executed"].includes(result.status)&&result.events.length!==1))throw new MySoAccessError(502,"The organization receipt did not match the exact prepared action");
        return Response.json(result,{headers:HEADERS});
    }catch(error){if(error instanceof z.ZodError)return Response.json({error:"Organization role or invitation request has an unsupported format"},{status:400,headers:HEADERS});return mySoErrorResponse(error);}
}
