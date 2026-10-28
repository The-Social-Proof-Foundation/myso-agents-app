import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
/** Post tips only: profile, comment and repost tips are not offered here. */
export const TIP_POST_ACTION="payments.tip_post.v1";
const MYSO_COIN="0x2::myso::MYSO";
const objectId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const decimal=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value=>BigInt(value)<=18446744073709551615n);
const key=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const operationSchema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("status")}).strict(),
    z.object({operation:z.literal("coins")}).strict(),
    z.object({operation:z.literal("request"),idempotencyKey:key,postId:objectId,paymentCoinId:objectId,amountBaseUnits:decimal}).strict(),
    z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict(),
    z.object({operation:z.literal("prepare"),idempotencyKey:key,approvalId:z.uuid(),parameters:z.object({postId:objectId,paymentCoinId:objectId,coinType:z.literal(MYSO_COIN),amountBaseUnits:decimal,mode:z.literal("simple")}).strict()}).strict(),
    z.object({operation:z.literal("submit"),idempotencyKey:key,approvalId:z.uuid(),digest,walletSignature:z.string().min(1).max(4096)}).strict(),
    z.object({operation:z.literal("receipt"),digest}).strict(),
]);
type Auth=Awaited<ReturnType<typeof authenticatedMySo>>;
async function call(auth:Auth,tool:string,args:Record<string,unknown>,message:string,signal?:AbortSignal){
    const result=await auth.mcp.callTool(tool,args,signal);
    if(!result.ok)throw new MySoAccessError(409,message);
    return result.data;
}
/** The connected agent's live per-action MYSO ceiling: the tip budget. */
async function perActionLimit(auth:Auth,signal?:AbortSignal):Promise<string>{
    const limit=z.union([decimal,z.literal("unlimited")]);
    const quote=z.object({agent:z.object({expectedLimitMist:limit,active:z.boolean(),effectiveAuthority:z.object({activeNow:z.boolean(),effectivePerActionSpendLimitMist:limit}).passthrough().optional()}).passthrough()}).passthrough().parse(await call(auth,"agent_admin_get_quote",{id:auth.scope.agentId},"The connected agent's spending limit is unavailable",signal));
    if(!quote.agent.active||quote.agent.effectiveAuthority?.activeNow===false)throw new MySoAccessError(403,"The connected agent is not active");
    return quote.agent.effectiveAuthority?.effectivePerActionSpendLimitMist??quote.agent.expectedLimitMist;
}
/** Pure: is this tip within the per-action ceiling? (Exported for tests.) */
export function tipWithinLimit(amountBaseUnits:string,limitMist:string):boolean{
    const amount=BigInt(amountBaseUnits);
    return amount>0n&&(limitMist==="unlimited"||amount<=BigInt(limitMist));
}

export async function handleMySoPostTips(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for post tip steps");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Tip request is not valid JSON");}
        const input=operationSchema.parse(raw);
        const available=auth.permittedActions.includes(TIP_POST_ACTION);
        if(input.operation==="status"){
            return Response.json({available,limitMist:available?await perActionLimit(auth,req.signal):null},{headers:HEADERS});
        }
        if(!available)throw new MySoAccessError(403,"Post tips are not in the connected agent's action catalog");
        if(input.operation==="coins"){
            const page=z.object({data:z.array(z.object({coinObjectId:objectId,coinType:z.string(),balanceBaseUnits:z.string().regex(/^(0|[1-9][0-9]*)$/)}).passthrough()),hasNextPage:z.boolean()}).passthrough().parse(await call(auth,"payments_list_coins",{coinType:MYSO_COIN,limit:50},"Owner wallet MYSO coins are unavailable; verify payments:read access",req.signal));
            return Response.json({coins:page.data,hasMore:page.hasNextPage},{headers:HEADERS});
        }
        if(input.operation==="request"){
            const limit=await perActionLimit(auth,req.signal);
            if(!tipWithinLimit(input.amountBaseUnits,limit))throw new MySoAccessError(400,"The tip must be more than zero and within the agent's per-action limit");
            const parameters={postId:input.postId,paymentCoinId:input.paymentCoinId,coinType:MYSO_COIN,amountBaseUnits:input.amountBaseUnits,mode:"simple"};
            const approval=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional()}).passthrough().parse(await call(auth,"chain_request_action_approval",{registryAction:TIP_POST_ACTION,parameters,idempotencyKey:input.idempotencyKey,expiresInSeconds:600},"The exact owner approval for this tip could not be created",req.signal));
            const approvalId=approval.approvalId??approval.approval_id;const approvalIntent=approval.approvalIntent??approval.approval_intent;
            if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"The approval response omitted its signed intent");
            return Response.json({approvalId,approvalIntent,registryAction:TIP_POST_ACTION,parameters,idempotencyKey:input.idempotencyKey},{headers:HEADERS});
        }
        if(input.operation==="approve"){
            await call(auth,"chain_approve_action",{approvalId:input.approvalId,walletSignature:input.walletSignature},"The owner signature was not accepted for this exact tip",req.signal);
            return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});
        }
        if(input.operation==="prepare"){
            if(!tipWithinLimit(input.parameters.amountBaseUnits,await perActionLimit(auth,req.signal)))throw new MySoAccessError(409,"The agent's per-action limit changed; this tip is now above it");
            const prepared=z.object({bytes:z.string().min(1),digest}).passthrough().parse(await call(auth,"chain_prepare_approved_action",{registryAction:TIP_POST_ACTION,parameters:input.parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},"The approved tip is stale or could not be prepared",req.signal));
            return Response.json({approvalId:input.approvalId,registryAction:TIP_POST_ACTION,idempotencyKey:input.idempotencyKey,bytes:prepared.bytes,digest:prepared.digest},{headers:HEADERS});
        }
        if(input.operation==="submit"){
            await call(auth,"chain_submit_approved_action",{registryAction:TIP_POST_ACTION,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},"The signed tip was not accepted; check the same digest before retrying",req.signal);
            return Response.json({submitted:true,digest:input.digest,registryAction:TIP_POST_ACTION},{headers:HEADERS});
        }
        const receipt=z.object({digest:z.string(),registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"])}).passthrough().parse(await call(auth,"chain_get_action_receipt",{id:input.digest},"The tip receipt is not available yet",req.signal));
        if(receipt.digest!==input.digest||receipt.registryAction!==TIP_POST_ACTION)throw new MySoAccessError(502,"The action receipt did not match this tip");
        return Response.json(receipt,{headers:HEADERS});
    }catch(error){
        if(error instanceof z.ZodError)return Response.json({error:"The tip request or response had an unsupported format"},{status:400,headers:HEADERS});
        return mySoErrorResponse(error);
    }
}
