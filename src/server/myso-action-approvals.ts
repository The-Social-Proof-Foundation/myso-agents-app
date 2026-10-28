import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const id=z.string().uuid();
const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const key=z.string().min(8).max(128);
const object=z.record(z.string(),z.unknown());
const schema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("list")}).strict(),
    z.object({operation:z.literal("approve"),approvalId:id,walletSignature:z.string().min(80).max(4096)}).strict(),
    z.object({operation:z.literal("prepare"),approvalId:id,registryAction:z.string().min(1).max(128),idempotencyKey:key,parameters:object}).strict(),
    z.object({operation:z.literal("submit"),approvalId:id,registryAction:z.string().min(1).max(128),idempotencyKey:key,digest,walletSignature:z.string().min(1).max(4096)}).strict(),
    z.object({operation:z.literal("receipt"),digest}).strict(),
]);
const unwrap=(result:{ok:boolean;data?:unknown},message:string)=>{if(!result.ok)throw new MySoAccessError(409,message);return result.data;};

export async function handleMySoActionApprovals(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for owner action approvals");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Approval request is not valid JSON");}
        const input=schema.parse(raw);
        if(input.operation==="list"){
            const rows=unwrap(await auth.mcp.callTool("chain_list_action_approvals",{limit:100},req.signal),"Pending owner approvals are unavailable to this account");
            const result=z.object({items:z.array(z.object({approvalId:id,registryAction:z.string(),registryVersion:z.string(),idempotencyKey:key,parameterHash:z.string(),parameters:object,requiredCapability:z.number().int().nonnegative(),riskTier:z.string(),ownerAddress:z.string(),approvalIntent:z.string(),status:z.literal("pending"),expiresAtMs:z.number().int()}).passthrough()).max(100)}).passthrough().parse(rows);
            return Response.json(result,{headers});
        }
        if(input.operation==="approve"){
            unwrap(await auth.mcp.callTool("chain_approve_action",{approvalId:input.approvalId,walletSignature:input.walletSignature},req.signal),"Owner wallet signature was not accepted");
            return Response.json({approvalId:input.approvalId,approved:true},{headers});
        }
        if(input.operation==="prepare"){
            const result=z.object({bytes:z.string().min(1),digest}).passthrough().parse(unwrap(await auth.mcp.callTool("chain_prepare_approved_action",{registryAction:input.registryAction,parameters:input.parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},req.signal),"The exact approved transaction could not be prepared"));
            return Response.json({...result,approvalId:input.approvalId,registryAction:input.registryAction,idempotencyKey:input.idempotencyKey},{headers});
        }
        if(input.operation==="submit"){
            unwrap(await auth.mcp.callTool("chain_submit_approved_action",{registryAction:input.registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},req.signal),"The signed transaction was not accepted");
            return Response.json({submitted:true,digest:input.digest,registryAction:input.registryAction},{headers});
        }
        const result=unwrap(await auth.mcp.callTool("chain_get_action_receipt",{id:input.digest},req.signal),"The matching action receipt is not available yet");
        const receipt=z.object({digest,registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"])}).passthrough().parse(result);
        if(receipt.digest!==input.digest)throw new MySoAccessError(502,"The action receipt did not match the submitted transaction");
        return Response.json(receipt,{headers});
    }catch(error){if(error instanceof z.ZodError)return Response.json({error:"The owner approval request or response had an unsupported format"},{status:400,headers});return mySoErrorResponse(error);}
}
