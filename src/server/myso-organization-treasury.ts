import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const amount=z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value=>BigInt(value)<=18446744073709551615n);
const key=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const actions={grant:"organization.grant_treasury_access.v1",withdraw:"organization.withdraw_treasury.v1",fund:"organization.fund_treasury.v1"} as const;
type Action=keyof typeof actions;
const paramsSchema=z.discriminatedUnion("action",[
    z.object({action:z.literal("grant"),organizationId:id,recipient:id,hasAccess:z.boolean()}).strict(),
    z.object({action:z.literal("withdraw"),organizationId:id,recipient:id,amountBaseUnits:amount,coinType:z.string().min(1).max(512)}).strict(),
    z.object({action:z.literal("fund"),organizationId:id,paymentCoinId:id,amountBaseUnits:amount,coinType:z.string().min(1).max(512)}).strict(),
]);
const request=z.object({operation:z.literal("request"),action:z.enum(["grant","withdraw","fund"]),parameters:z.unknown(),idempotencyKey:key,signerAddress:id.optional()}).strict();
const approve=z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict();
const prepare=z.object({operation:z.literal("prepare"),action:z.enum(["grant","withdraw","fund"]),parameters:z.unknown(),idempotencyKey:key,approvalId:z.uuid()}).strict();
const submit=z.object({operation:z.literal("submit"),action:z.enum(["grant","withdraw","fund"]),idempotencyKey:key,approvalId:z.uuid(),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),walletSignature:z.string().min(1).max(4096)}).strict();
const read=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("balance"),organizationId:id,coinType:z.string().min(1).max(512)}).strict(),
    z.object({operation:z.literal("access"),organizationId:id,recipient:id}).strict(),
    z.object({operation:z.literal("receipt"),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).strict(),
]);
function data(result:{ok:boolean;data?:unknown},message:string){if(!result.ok)throw new MySoAccessError(409,message);return result.data;}
export async function handleMySoOrganizationTreasury(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for organization treasury actions");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Treasury request is not valid JSON");}
        if(raw&&typeof raw==="object"&&"operation" in raw){
            const operation=(raw as {operation:unknown}).operation;
            if(operation==="request"){
                const input=request.parse(raw);const parameters=paramsSchema.parse({action:input.action,...(input.parameters as object)});
                const registryAction=actions[input.action];
                const tool={grant:"organization_grant_treasury_access",withdraw:"organization_withdraw_treasury",fund:"organization_fund_treasury"}[input.action];
                const result= data(await auth.mcp.callTool(tool,{...parameters,idempotencyKey:input.idempotencyKey,expiresInSeconds:600,...(input.signerAddress?{signerAddress:input.signerAddress}:{})},req.signal),"Exact organization treasury approval could not be created");
                const approval=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional()}).passthrough().parse(result);
                const approvalId=approval.approvalId??approval.approval_id;const approvalIntent=approval.approvalIntent??approval.approval_intent;
                if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"Approval response omitted its signed owner intent");
                return Response.json({action:input.action,kind:input.action,organizationId:parameters.organizationId,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId,approvalIntent},{headers:HEADERS});
            }
            if(operation==="approve"){
                const input=approve.parse(raw);data(await auth.mcp.callTool("chain_approve_action",input,req.signal),"Owner wallet signature was not accepted");
                return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});
            }
            if(operation==="prepare"){
                const input=prepare.parse(raw);const parameters=paramsSchema.parse({action:input.action,...(input.parameters as object)});
                const registryAction=actions[input.action];
                const value=z.object({bytes:z.string().min(1),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).passthrough().parse(data(await auth.mcp.callTool("chain_prepare_approved_action",{registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},req.signal),"Approved treasury transaction could not be prepared"));
                return Response.json({action:input.action,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,...value},{headers:HEADERS});
            }
            if(operation==="submit"){
                const input=submit.parse(raw);const registryAction=actions[input.action];
                data(await auth.mcp.callTool("chain_submit_approved_action",{registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},req.signal),"Signed treasury transaction was not accepted");
                return Response.json({submitted:true,digest:input.digest,registryAction},{headers:HEADERS});
            }
            const input=read.parse(raw);
            if(input.operation==="balance")return Response.json(data(await auth.mcp.callTool("organization_get_treasury_balance",{id:input.organizationId,coinType:input.coinType},req.signal),"Live organization treasury balance is unavailable"),{headers:HEADERS});
            if(input.operation==="access")return Response.json(data(await auth.mcp.callTool("organization_get_treasury_access",{id:input.organizationId,recipient:input.recipient},req.signal),"Live organization treasury access is unavailable"),{headers:HEADERS});
            return Response.json(data(await auth.mcp.callTool("chain_get_action_receipt",{id:input.digest},req.signal),"Treasury transaction receipt is not available yet"),{headers:HEADERS});
        }
        throw new MySoAccessError(400,"Unsupported organization treasury operation");
    }catch(error){if(error instanceof z.ZodError)return Response.json({error:"Treasury request has an unsupported format"},{status:400,headers:HEADERS});return mySoErrorResponse(error);}
}
