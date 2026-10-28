import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
/** The five owner subscription actions; nothing else is approvable here. */
export const SUBSCRIPTION_ACTIONS={
    subscribe:"subscription.subscribe_to_plan.v1",
    renew:"subscription.renew_subscription.v1",
    cancel:"subscription.cancel_subscription.v1",
    enable_auto_renew:"subscription.enable_auto_renew.v1",
    disable_auto_renew:"subscription.disable_auto_renew.v1",
    change_payment_recipient:"subscription.change_service_payment_recipient.v1",
} as const;
export type SubscriptionAction=keyof typeof SUBSCRIPTION_ACTIONS;
const actionSchema=z.enum(Object.keys(SUBSCRIPTION_ACTIONS) as [SubscriptionAction,...SubscriptionAction[]]);
const objectId=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const cursor=z.string().min(1).max(200);
const decimal=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value=>BigInt(value)<=18446744073709551615n);
const key=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
const digest=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const termsSchema=z.object({planId:z.string().min(1),expectedProfileOwner:z.string().min(1),coinType:z.string().min(1),priceBaseUnits:decimal,durationMs:decimal,tierLevel:z.string().min(1).optional(),planPlatformId:z.string().min(1).optional()}).strict();
const planQuoteSchema=z.object({serviceId:z.string(),terms:termsSchema,planActive:z.boolean(),serviceActive:z.boolean(),maxRenewalPeriods:decimal,deploymentEnabled:z.boolean()}).passthrough();
const subscriptionSchema=z.object({subscriptionId:z.string(),serviceId:z.string(),planId:z.string(),coinType:z.string(),expiresAtMs:decimal,autoRenew:z.boolean()}).passthrough();
const renewalQuoteSchema=planQuoteSchema.extend({subscription:subscriptionSchema});
const requestSchema=z.discriminatedUnion("action",[
    z.object({operation:z.literal("request"),action:z.literal("subscribe"),idempotencyKey:key,serviceId:objectId,planId:objectId,paymentCoinId:objectId,autoRenew:z.boolean(),renewalPeriods:decimal}).strict(),
    z.object({operation:z.literal("request"),action:z.literal("renew"),idempotencyKey:key,subscriptionId:objectId,paymentCoinId:objectId}).strict(),
    z.object({operation:z.literal("request"),action:z.enum(["cancel","enable_auto_renew","disable_auto_renew"]),idempotencyKey:key,subscriptionId:objectId}).strict(),
    z.object({operation:z.literal("request"),action:z.literal("change_payment_recipient"),idempotencyKey:key,serviceId:objectId,newRecipient:objectId}).strict(),
]);
const operationSchema=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("list"),cursor:cursor.optional()}).strict(),
    z.object({operation:z.literal("owner-services"),offset:z.number().int().min(0).max(100000).optional()}).strict(),
    z.object({operation:z.literal("service-revenue"),serviceId:objectId,offset:z.number().int().min(0).max(100000).optional()}).strict(),
    z.object({operation:z.literal("get"),subscriptionId:objectId}).strict(),
    z.object({operation:z.literal("renewal-quote"),subscriptionId:objectId}).strict(),
    z.object({operation:z.literal("plans"),serviceId:objectId,cursor:cursor.optional()}).strict(),
    z.object({operation:z.literal("quote"),serviceId:objectId,planId:objectId}).strict(),
    z.object({operation:z.literal("coins"),coinType:z.string().min(3).max(300)}).strict(),
    z.object({operation:z.literal("approve"),approvalId:z.uuid(),walletSignature:z.string().min(80).max(4096)}).strict(),
    z.object({operation:z.literal("prepare"),action:actionSchema,idempotencyKey:key,approvalId:z.uuid(),parameters:z.record(z.string(),z.unknown())}).strict(),
    z.object({operation:z.literal("submit"),action:actionSchema,idempotencyKey:key,approvalId:z.uuid(),digest,walletSignature:z.string().min(1).max(4096)}).strict(),
    z.object({operation:z.literal("receipt"),action:actionSchema,digest}).strict(),
]);
type Auth=Awaited<ReturnType<typeof authenticatedMySo>>;
async function read(auth:Auth,tool:string,args:Record<string,unknown>,message:string,signal?:AbortSignal){
    const result=await auth.mcp.callTool(tool,args,signal);
    if(!result.ok)throw new MySoAccessError(409,message);
    return result.data;
}
/** Re-read live chain terms and build the exact registry parameters; the
 *  client never supplies terms, prices or the service a subscription is in. */
async function parametersFor(auth:Auth,input:z.infer<typeof requestSchema>,signal?:AbortSignal):Promise<Record<string,unknown>>{
    if(input.action==="change_payment_recipient"){
        // The action approval resolver re-reads the exact service from the
        // configured fullnode and checks its live profile_owner against the
        // authenticated account. Do not make a public indexer snapshot an
        // authorization prerequisite; it may lag a valid newly created service.
        return {serviceId:input.serviceId,newRecipient:input.newRecipient};
    }
    if(input.action==="subscribe"){
        const quote=planQuoteSchema.parse(await read(auth,"subscription_get_plan_quote",{serviceId:input.serviceId,planId:input.planId},"This plan quote is unavailable to the connected account",signal));
        if(!quote.deploymentEnabled)throw new MySoAccessError(403,"Subscription purchases are disabled for this deployment");
        if(!quote.planActive||!quote.serviceActive)throw new MySoAccessError(409,"This plan is not currently open for new subscriptions");
        if(!input.autoRenew&&input.renewalPeriods!=="0")throw new MySoAccessError(400,"Turn on auto-renew to prepay more than one period");
        if(BigInt(input.renewalPeriods)>BigInt(quote.maxRenewalPeriods))throw new MySoAccessError(400,`This plan allows at most ${quote.maxRenewalPeriods} prepaid renewal periods`);
        return {serviceId:quote.serviceId,paymentCoinId:input.paymentCoinId,terms:quote.terms,autoRenew:input.autoRenew,renewalPeriods:input.renewalPeriods};
    }
    if(input.action==="renew"){
        const quote=renewalQuoteSchema.parse(await read(auth,"subscription_get_renewal_quote",{id:input.subscriptionId},"The renewal quote for this subscription is unavailable",signal));
        return {serviceId:quote.subscription.serviceId,subscriptionId:quote.subscription.subscriptionId,paymentCoinId:input.paymentCoinId,terms:quote.terms};
    }
    const subscription=subscriptionSchema.parse(await read(auth,"subscription_get",{id:input.subscriptionId},"This subscription is unavailable to the connected owner",signal));
    if(input.action==="enable_auto_renew"&&subscription.autoRenew)throw new MySoAccessError(409,"Auto-renew is already on; refresh before changing it");
    if(input.action==="disable_auto_renew"&&!subscription.autoRenew)throw new MySoAccessError(409,"Auto-renew is already off; refresh before changing it");
    if(input.action==="cancel")return {serviceId:subscription.serviceId,subscriptionId:subscription.subscriptionId,coinType:subscription.coinType};
    return {serviceId:subscription.serviceId,subscriptionId:subscription.subscriptionId};
}

export async function handleMySoSubscriptions(req:Request){
    try{
        if(req.method!=="POST")throw new MySoAccessError(405,"Use POST for subscription steps");
        const auth=await authenticatedMySo(req);let raw:unknown;
        try{raw=await req.json();}catch{throw new MySoAccessError(400,"Subscription request is not valid JSON");}
        if(raw&&typeof raw==="object"&&(raw as {operation?:unknown}).operation==="request"){
            const input=requestSchema.parse(raw);const parameters=await parametersFor(auth,input,req.signal);const registryAction=SUBSCRIPTION_ACTIONS[input.action];
            const approval=z.object({approvalId:z.uuid().optional(),approval_id:z.uuid().optional(),approvalIntent:z.string().min(1).optional(),approval_intent:z.string().min(1).optional(),expiresAtMs:z.number().optional(),expires_at_ms:z.number().optional()}).passthrough().parse(await read(auth,"chain_request_action_approval",{registryAction,parameters,idempotencyKey:input.idempotencyKey,expiresInSeconds:600},"The exact owner approval request could not be created",req.signal));
            const approvalId=approval.approvalId??approval.approval_id;const approvalIntent=approval.approvalIntent??approval.approval_intent;
            if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"The approval response omitted its signed intent");
            return Response.json({approvalId,approvalIntent,expiresAtMs:approval.expiresAtMs??approval.expires_at_ms,registryAction,parameters,idempotencyKey:input.idempotencyKey},{headers:HEADERS});
        }
        const input=operationSchema.parse(raw);
        if(input.operation==="list")return Response.json(z.object({items:z.array(subscriptionSchema),nextCursor:z.string().nullable(),hasNextPage:z.boolean()}).passthrough().parse(await read(auth,"subscription_list",{...(input.cursor?{cursor:input.cursor}:{}),limit:50},"Your subscriptions are unavailable; verify subscription:read access",req.signal)),{headers:HEADERS});
        if(input.operation==="owner-services"){
            const value=await read(auth,"social_list_profile_subscription_services",{address:auth.scope.owner,limit:100,offset:input.offset??0},"Your creator services are unavailable",req.signal);
            const items=Array.isArray(value)?value:[];
            return Response.json({items,hasMore:items.length===100},{headers:HEADERS});
        }
        if(input.operation==="service-revenue"){
            const value=await read(auth,"social_list_service_subscription_revenue",{serviceId:input.serviceId,limit:50,offset:input.offset??0},"Indexed service revenue is unavailable",req.signal);
            const items=Array.isArray(value)?value:[];
            return Response.json({items,hasMore:items.length===50},{headers:HEADERS});
        }
        if(input.operation==="get")return Response.json(subscriptionSchema.parse(await read(auth,"subscription_get",{id:input.subscriptionId},"This subscription is unavailable to the connected owner",req.signal)),{headers:HEADERS});
        if(input.operation==="renewal-quote")return Response.json(renewalQuoteSchema.parse(await read(auth,"subscription_get_renewal_quote",{id:input.subscriptionId},"The renewal quote for this subscription is unavailable",req.signal)),{headers:HEADERS});
        if(input.operation==="plans")return Response.json(z.object({serviceId:z.string(),items:z.array(z.object({terms:termsSchema,active:z.boolean(),planMetadata:z.unknown()}).passthrough()),nextCursor:z.string().nullable(),hasNextPage:z.boolean()}).passthrough().parse(await read(auth,"subscription_list_plans",{serviceId:input.serviceId,...(input.cursor?{cursor:input.cursor}:{}),limit:50},"This service's plans are unavailable",req.signal)),{headers:HEADERS});
        if(input.operation==="quote")return Response.json(planQuoteSchema.parse(await read(auth,"subscription_get_plan_quote",{serviceId:input.serviceId,planId:input.planId},"This plan quote is unavailable to the connected account",req.signal)),{headers:HEADERS});
        if(input.operation==="coins"){
            const page=z.object({data:z.array(z.object({coinObjectId:objectId,coinType:z.string(),balanceBaseUnits:z.string().regex(/^(0|[1-9][0-9]*)$/)}).passthrough()),hasNextPage:z.boolean()}).passthrough().parse(await read(auth,"payments_list_coins",{coinType:input.coinType,limit:50},"Owner wallet coins are unavailable; verify payments:read access",req.signal));
            return Response.json({coins:page.data,hasMore:page.hasNextPage},{headers:HEADERS});
        }
        if(input.operation==="approve"){
            await read(auth,"chain_approve_action",{approvalId:input.approvalId,walletSignature:input.walletSignature},"The owner signature was not accepted for this exact subscription change",req.signal);
            return Response.json({approvalId:input.approvalId,approved:true},{headers:HEADERS});
        }
        if(input.operation==="prepare"){
            const registryAction=SUBSCRIPTION_ACTIONS[input.action];
            const prepared=z.object({bytes:z.string().min(1),digest}).passthrough().parse(await read(auth,"chain_prepare_approved_action",{registryAction,parameters:input.parameters,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId},"The approved subscription change is stale or could not be prepared",req.signal));
            return Response.json({approvalId:input.approvalId,registryAction,idempotencyKey:input.idempotencyKey,bytes:prepared.bytes,digest:prepared.digest},{headers:HEADERS});
        }
        if(input.operation==="submit"){
            const registryAction=SUBSCRIPTION_ACTIONS[input.action];
            await read(auth,"chain_submit_approved_action",{registryAction,idempotencyKey:input.idempotencyKey,approvalId:input.approvalId,digest:input.digest,walletSignature:input.walletSignature},"The signed subscription transaction was not accepted; check the same digest before retrying",req.signal);
            return Response.json({submitted:true,digest:input.digest,registryAction},{headers:HEADERS});
        }
        const receipt=z.object({digest:z.string(),registryAction:z.string(),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().nullable().optional(),events:z.array(z.unknown())}).passthrough().parse(await read(auth,"subscription_get_receipt",{id:input.digest},"The subscription receipt is not available yet",req.signal));
        if(receipt.digest!==input.digest||receipt.registryAction!==SUBSCRIPTION_ACTIONS[input.action])throw new MySoAccessError(502,"The fullnode evidence did not match this exact subscription change");
        return Response.json(receipt,{headers:HEADERS});
    }catch(error){
        if(error instanceof z.ZodError)return Response.json({error:"The subscription request or response had an unsupported format"},{status:400,headers:HEADERS});
        return mySoErrorResponse(error);
    }
}
