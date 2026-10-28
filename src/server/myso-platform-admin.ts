import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";
const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);const key=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const ACTIONS={transfer:"platform.transfer_platform.v1",fee:"platform.update_fee_recipient.v1"} as const;
const payload=z.discriminatedUnion("action",[
 z.object({action:z.literal("transfer"),platformId:id,platformAdminCapId:id,newDeveloper:id}).strict(),
 z.object({action:z.literal("fee"),platformAdminCapId:id,newRecipient:id}).strict(),
]);
const schema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("request"),payload:z.unknown(),idempotencyKey:key}).strict(),
 z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict(),
 z.object({operation:z.literal("prepare"),action:z.enum(["transfer","fee"]),parameters:z.unknown(),idempotencyKey:key,approvalId:z.uuid()}).strict(),
 z.object({operation:z.literal("submit"),action:z.enum(["transfer","fee"]),idempotencyKey:key,approvalId:z.uuid(),digest,walletSignature:z.string().min(1).max(4096)}).strict(),
 z.object({operation:z.literal("receipt"),digest}).strict(),
]);
function unwrap(result:{ok:boolean;data?:unknown},message:string){if(!result.ok)throw new MySoAccessError(409,message);return result.data;}
export async function handleMySoPlatformAdmin(req:Request){try{
 if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for platform administration");const auth=await authenticatedMySo(req);let raw:unknown;try{raw=await req.json();}catch{throw new MySoAccessError(400,"Platform action request is not valid JSON");}const input=schema.parse(raw);
 if(input.operation==="request"){
  const parsed=payload.parse(input.payload);const {action,...parameters}=parsed;const registryAction=ACTIONS[action];const tool=action==="transfer"?"platform_transfer_developer":"platform_update_fee_recipient";
  const result=unwrap(await auth.mcp.callTool(tool,{...parameters,idempotencyKey:input.idempotencyKey,expiresInSeconds:600},req.signal),"Platform owner approval could not be created");
  const approval=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional()}).passthrough().parse(result);const approvalId=approval.approvalId??approval.approval_id;const approvalIntent=approval.approvalIntent??approval.approval_intent;if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"Owner approval omitted its signed intent");return Response.json({action,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId,approvalIntent},{headers:HEADERS});
 }
 if(input.operation==="approve"){unwrap(await auth.mcp.callTool("chain_approve_action",input,req.signal),"Platform owner signature was not accepted");return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});}
 if(input.operation==="prepare"){
  const parsed=payload.parse({action:input.action,...(input.parameters as object)});const {action,...parameters}=parsed;const registryAction=ACTIONS[action];const value=z.object({bytes:z.string().min(1),digest}).passthrough().parse(unwrap(await auth.mcp.callTool("chain_prepare_approved_action",{registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},req.signal),"Approved platform action could not be prepared"));return Response.json({action,registryAction,parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,...value},{headers:HEADERS});
 }
 if(input.operation==="submit"){const registryAction=ACTIONS[input.action];unwrap(await auth.mcp.callTool("chain_submit_approved_action",{registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},req.signal),"Signed platform transaction was not accepted");return Response.json({submitted:true,digest:input.digest,registryAction},{headers:HEADERS});}
 return Response.json(unwrap(await auth.mcp.callTool("chain_get_action_receipt",{id:input.digest},req.signal),"Platform action receipt is not available yet"),{headers:HEADERS});
}catch(error){if(error instanceof z.ZodError)return Response.json({error:"Platform administration request has an unsupported format"},{status:400,headers:HEADERS});return mySoErrorResponse(error);}}
