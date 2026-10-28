import { randomUUID } from "node:crypto";
import { z } from "zod";
import { myDataContentPageSchema, myDataContentRequestSchema, myDataGraphOfferPageSchema, myDataGraphOfferProofSchema, myDataListingPageSchema, myDataListingsRequestSchema, myDataOwnerAccessHistorySchema, myDataPurchaseHistorySchema, myDataPurchaseReceiptSchema, myDataQuoteRequestSchema, myDataQuoteSchema } from "../core/contracts/mydata.ts";
import { mySoGraphItemRequestSchema, mySoGraphItemResultSchema, mySoGraphPublishRequestSchema, mySoGraphSearchRequestSchema, mySoGraphSearchResultSchema } from "../core/contracts/myso-knowledge-graph.ts";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";
const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const sameId=(a:string,b:string)=>a.slice(2).toLowerCase().padStart(64,"0")===b.slice(2).toLowerCase().padStart(64,"0");
async function input(req:Request,maximumBytes=2048){
    if(!req.headers.get("content-type")?.includes("application/json")||!req.body)throw new MySoAccessError(415,"Send a JSON request");
    const reader=req.body.getReader();let text="";let size=0;const decoder=new TextDecoder("utf-8",{fatal:true});
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximumBytes)throw new MySoAccessError(413,"Request is too large");text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
    catch(error){if(error instanceof MySoAccessError)throw error;throw new MySoAccessError(400,"Request is not valid JSON");}
    finally{await reader.cancel().catch(()=>{});}
}
/** Fixed disclosure routes, outside work journals, model inference and persistent caches. */
export async function handleMySoPrivateData(req:Request,kind:"listings"|"owned-listings"|"graph-offers"|"quote"|"verify-offer"|"publish-graph"|"read"|"graph-search"|"graph-item"|"purchase-history"|"purchase-history-receipt"|"purchase-lifecycle"|"purchase"):Promise<Response>{
    try{
        const auth=await authenticatedMySo(req);
        const raw=await input(req,kind==="publish-graph"?240*1024:2048);
        if(kind==="purchase-history-receipt"){
            const asked=z.object({mydataId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).strict().parse(raw);
            const result=await auth.mcp.callTool("mydata_get_purchase_receipt",{id:asked.digest},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"A scoped fullnode purchase receipt could not be read");
            const parsed=myDataPurchaseReceiptSchema.safeParse(result.data);
            if(!parsed.success||parsed.data.digest!==asked.digest)throw new MySoAccessError(502,"The purchase receipt response did not match the requested transaction");
            if(parsed.data.evidenceSource!=="configured_fullnode"||parsed.data.status!=="finalized"||parsed.data.checkpoint===null)throw new MySoAccessError(409,"The purchase transaction has not reached checkpoint finality");
            const matching=parsed.data.receipts.filter(receipt=>sameId(receipt.mydataId,asked.mydataId)
                &&((receipt.buyerExecution==="owner_approved"&&sameId(receipt.buyerAddress,auth.scope.owner)&&sameId(receipt.buyerAccountId,auth.scope.accountId)&&receipt.buyerAgentId===null)
                    ||(receipt.buyerExecution==="agent_automated"&&sameId(receipt.buyerAddress,auth.derivedAddress)&&sameId(receipt.buyerAccountId,auth.scope.accountId)&&receipt.buyerAgentId!==null&&sameId(receipt.buyerAgentId,auth.scope.agentId))));
            if(matching.length!==1)throw new MySoAccessError(409,"This transaction has no unique finalized MyData purchase event for the authenticated owner or agent");
            return Response.json({digest:parsed.data.digest,status:parsed.data.status,checkpoint:parsed.data.checkpoint,receipt:matching[0],currentAccess:"not_checked"},{headers:HEADERS});
        }
        if(kind==="purchase-lifecycle"){
            const request=myDataListingsRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_list_owner_access_history",request,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Owner grant and revocation history is unavailable to your connected agent");
            const parsed=myDataOwnerAccessHistorySchema.safeParse(result.data);
            if(!parsed.success||!sameId(parsed.data.ownerAddress,auth.scope.owner)||!sameId(parsed.data.accountId,auth.scope.accountId)||!sameId(parsed.data.agentId,auth.scope.agentId)||!sameId(parsed.data.agentAddress,auth.derivedAddress))throw new MySoAccessError(502,"Access history did not match the authenticated account and agent");
            return Response.json(parsed.data,{headers:HEADERS});
        }
        if(kind==="purchase-history"){
            const request=myDataListingsRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_list_my_purchases",request,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Purchase history is unavailable to your connected agent");
            const parsed=myDataPurchaseHistorySchema.safeParse(result.data);
            if(!parsed.success||!sameId(parsed.data.ownerAddress,auth.scope.owner)||!sameId(parsed.data.agentAddress,auth.derivedAddress))throw new MySoAccessError(502,"Purchase history did not match the authenticated account and agent");
            return Response.json(parsed.data,{headers:HEADERS});
        }
        if(kind==="publish-graph"){
            const asked=mySoGraphPublishRequestSchema.parse(raw);
            if(!auth.scope.organizationId||!sameId(auth.scope.organizationId,asked.authorityProof.organizationId))throw new MySoAccessError(403,"Select the organization this connected agent is authorized to represent");
            if(Buffer.byteLength(JSON.stringify(asked),"utf8")>180*1024)throw new MySoAccessError(413,"The graph exceeds the supported private listing size");
            const result=await auth.mcp.callTool("mydata_publish_graph",{request:asked},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The connected agent cannot publish this graph under its current capabilities and organization authority");
            const data=result.data as Record<string,unknown>|null;
            const chain=data&&typeof data==="object"?data.chain as Record<string,unknown>|undefined:undefined;
            if(!data||data.registryAction!=="access.publish_mydata_graph.v1"||!chain||typeof chain.digest!=="string"||data.graphId!==asked.manifest.graphId||data.graphVersion!==asked.manifest.graphVersion||data.manifestHashHex===undefined)throw new MySoAccessError(502,"The graph publisher returned an unsupported transaction result");
            return Response.json({registryAction:data.registryAction,graphId:data.graphId,graphVersion:data.graphVersion,manifestHashHex:data.manifestHashHex,chain},{headers:HEADERS});
        }
        if(kind==="listings"||kind==="owned-listings"||kind==="graph-offers"){
            const request=myDataListingsRequestSchema.parse(raw);
            const tool=kind==="listings"?"mydata_list_listings":kind==="owned-listings"?"mydata_list_owned_listings":"mydata_list_graph_offers";
            const result=await auth.mcp.callTool(tool,request,req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Listing discovery is unavailable to your agent");
            if(kind==="graph-offers"){
                const parsed=myDataGraphOfferPageSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The graph offer service returned unsupported metadata");
                const canContinue=parsed.data.scannedCount===request.limit&&request.offset<100000&&request.offset+parsed.data.scannedCount<=100000;
                if(parsed.data.offset!==request.offset||parsed.data.scannedCount>request.limit||parsed.data.offers.length>parsed.data.scannedCount||parsed.data.nextOffset!==(canContinue?request.offset+parsed.data.scannedCount:null))throw new MySoAccessError(502,"The graph offer service returned an invalid page range");
                return Response.json(parsed.data,{headers:HEADERS});
            }
            const parsed=myDataListingPageSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The listing service returned unsupported metadata");
            const canContinue=parsed.data.scannedCount===request.limit&&request.offset<100000&&request.offset+parsed.data.scannedCount<=100000;
            if(parsed.data.offset!==request.offset||parsed.data.scannedCount>request.limit||parsed.data.listings.length>parsed.data.scannedCount||parsed.data.nextOffset!==(canContinue?request.offset+parsed.data.scannedCount:null))throw new MySoAccessError(502,"The listing service returned an invalid page range");
            return Response.json(parsed.data,{headers:HEADERS});
        }
        if(kind==="quote"){
            const request=myDataQuoteRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_get_purchase_quote",{id:request.mydataId},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The listing is unavailable to your agent");
            const parsed=myDataQuoteSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The listing service returned an unsupported quote");const quote=parsed.data;
            if(!sameId(quote.mydataId,request.mydataId)||!sameId(quote.purchaseParameters.mydataId,request.mydataId))throw new MySoAccessError(502,"The listing response did not match your request");
            return Response.json(quote,{headers:HEADERS});
        }
        if(kind==="verify-offer"){
            const request=myDataQuoteRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_verify_graph_offer",{request:{mydataId:request.mydataId}},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"The graph offer's seller proof could not be verified");
            const parsed=myDataGraphOfferProofSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The graph offer proof response is unsupported");
            if(!sameId(parsed.data.quote.mydataId,request.mydataId)||!sameId(parsed.data.publication.sellerAddress,parsed.data.quote.purchaseParameters.expectedSeller)||parsed.data.manifestHashHex!==parsed.data.publication.manifestHashHex)throw new MySoAccessError(502,"The graph offer proof did not match its live quote");
            return Response.json(parsed.data,{headers:HEADERS});
        }
        if(kind==="purchase"){
            const request=z.object({
                operation:z.enum(["coins","request","approve","prepare","submit","receipt","grant-request","grant-approve","grant-prepare","grant-submit","grant-receipt","revoke-request","revoke-approve","revoke-prepare","revoke-submit","revoke-receipt"]),
                mydataId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),graphId:z.string().min(1).max(128).optional(),graphVersion:z.number().int().positive().optional(),manifestHashHex:z.string().regex(/^[0-9a-f]{64}$/).optional(),
                audienceKind:z.enum(["agent","organization"]).optional(),accessKind:z.union([z.literal(2),z.literal(3)]).optional(),shareDurationDays:z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),organizationAudienceId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),paymentCoinId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional(),idempotencyKey:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:/-]+$/).optional(),approvalId:z.uuid().optional(),walletSignature:z.string().min(80).max(4096).optional(),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).optional(),buyerAcceptedOfferTerms:z.literal(true).optional(),acceptedPublicationSignatureHex:z.string().regex(/^[0-9a-f]{128}$/).optional(),
            }).strict().parse(raw);
            if(request.operation==="coins"){
                const result=await auth.mcp.callTool("payments_list_coins",{coinType:"0x2::myso::MYSO",limit:50},req.signal);
                if(!result.ok)throw new MySoAccessError(403,"Owner wallet MYSO coins are unavailable; verify payments:read access");
                const page=z.object({data:z.array(z.object({coinObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),coinType:z.string(),balanceBaseUnits:z.string().regex(/^(0|[1-9][0-9]*)$/)}).passthrough()),hasNextPage:z.boolean(),nextCursor:z.string().nullable().optional(),fundingModel:z.literal("owned_coin_objects")}).passthrough().parse(result.data);
                return Response.json({coins:page.data,hasMore:page.hasNextPage,cursor:page.nextCursor??null},{headers:HEADERS});
            }
            if(request.operation==="approve"){
                if(!request.approvalId||!request.walletSignature)throw new MySoAccessError(400,"Approval ID and owner wallet signature are required");
                const approved=await auth.mcp.callTool("chain_approve_action",{approvalId:request.approvalId,walletSignature:request.walletSignature},req.signal);
                if(!approved.ok)throw new MySoAccessError(409,"The owner signature was not accepted for this exact purchase approval");
                return Response.json({approved:true},{headers:HEADERS});
            }
            if(request.operation==="submit"){
                if(!request.approvalId||!request.idempotencyKey||!request.digest||!request.walletSignature)throw new MySoAccessError(400,"Approval, purchase reference, digest and wallet signature are required");
                const submitted=await auth.mcp.callTool("chain_submit_approved_action",{registryAction:"access.purchase_mydata_access.v1",idempotencyKey:request.idempotencyKey,approvalId:request.approvalId,digest:request.digest,walletSignature:request.walletSignature},req.signal);
                if(!submitted.ok)throw new MySoAccessError(409,"The signed transaction was not accepted; check chain status before trying again");
                return Response.json({submitted:true,transaction:submitted.data},{headers:HEADERS});
            }
            if(request.operation==="receipt"){
                if(!request.digest||!request.mydataId||!request.audienceKind)throw new MySoAccessError(400,"Purchase digest, listing, and chosen audience are required");
                const receipt=await auth.mcp.callTool("mydata_get_purchase_receipt",{id:request.digest},req.signal);
                if(!receipt.ok)throw new MySoAccessError(409,"The purchase is not yet available as finalized fullnode receipt evidence");
                if(Buffer.byteLength(JSON.stringify(receipt.data),"utf8")>64*1024)throw new MySoAccessError(502,"Purchase receipt exceeds the supported response size");
                const evidence=z.object({digest:z.string(),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().nullable(),receipts:z.array(z.object({mydataId:z.string(),buyerAddress:z.string(),buyerAccountId:z.string(),buyerAgentId:z.string().nullable(),buyerExecution:z.enum(["owner_approved","agent_automated"]),organizationAudienceId:z.string().nullable(),seller:z.string(),accessKind:z.number().int(),priceMist:z.string(),durationDays:z.string(),encryptedDataDigestHex:z.string(),encryptionIdDigestHex:z.string()}).passthrough())}).passthrough().parse(receipt.data);
                if(evidence.digest!==request.digest||evidence.status!=="finalized"||!evidence.checkpoint)throw new MySoAccessError(409,"The purchase transaction has not reached checkpoint finality yet");
                const mydataId=request.mydataId;const quoteResult=await auth.mcp.callTool("mydata_get_purchase_quote",{id:mydataId},req.signal);if(!quoteResult.ok)throw new MySoAccessError(409,"The exact MyData purchase quote is unavailable for receipt comparison");
                const quote=myDataQuoteSchema.parse(quoteResult.data);if(quote.mediaType!=="application/vnd.mysocial.graph-manifest+json;version=1")throw new MySoAccessError(409,"The finalized purchase is not a GraphManifest listing");const item=evidence.receipts.find(value=>sameId(value.mydataId,mydataId)&&value.buyerExecution==="owner_approved"&&sameId(value.buyerAddress,auth.scope.owner)&&sameId(value.buyerAccountId,auth.scope.accountId)&&value.buyerAgentId===null);
                if(!item||!sameId(item.seller,quote.purchaseParameters.expectedSeller)||item.accessKind!==quote.purchaseParameters.accessKind||item.priceMist!==quote.purchaseParameters.priceMist||item.durationDays!==quote.purchaseParameters.durationDays||item.encryptedDataDigestHex!==quote.purchaseParameters.encryptedDataDigestHex)throw new MySoAccessError(409,"The finalized event does not prove this owner's exact quoted graph purchase");
                const requestedOrg=request.audienceKind==="organization"?request.organizationAudienceId:undefined;
                if(request.audienceKind==="organization"?(!requestedOrg||!item.organizationAudienceId||!sameId(requestedOrg,item.organizationAudienceId)):!!item.organizationAudienceId)throw new MySoAccessError(409,"The finalized event audience does not match the audience selected for this purchase");
                return Response.json({receipt:item,digest:evidence.digest,checkpoint:evidence.checkpoint,verification:"finalized_owner_approved_bounded_purchase"},{headers:HEADERS});
            }
            if(request.operation.startsWith("revoke-")){
                if(!request.mydataId||!request.accessKind||!request.idempotencyKey&&request.operation!=="revoke-receipt")throw new MySoAccessError(400,"Listing, access type and idempotency key are required for agent-access revocation");
                if(request.audienceKind!=="agent")throw new MySoAccessError(400,"Per-agent revocation applies only to an agent-audience purchase; organization readers are governed by live organization permissions");
                const registryAction="access.revoke_mydata_share.v1";
                const accessType=request.accessKind===2?0:1;
                const parameters={mydataId:request.mydataId,recipient:auth.derivedAddress,accessType};
                if(request.operation==="revoke-request"){
                    const action=await auth.mcp.callTool("chain_request_action_approval",{registryAction,parameters,idempotencyKey:request.idempotencyKey,expiresInSeconds:600},req.signal);
                    if(!action.ok)throw new MySoAccessError(409,"Exact owner approval for agent access revocation could not be requested");
                    const parsed=z.object({approvalId:z.string().uuid().optional(),approval_id:z.string().uuid().optional(),approvalIntent:z.string().optional(),approval_intent:z.string().optional()}).passthrough().parse(action.data);
                    const approvalId=parsed.approvalId??parsed.approval_id;const approvalIntent=parsed.approvalIntent??parsed.approval_intent;
                    if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"The access-revocation approval response omitted its signature intent");
                    return Response.json({approvalId,approvalIntent,idempotencyKey:request.idempotencyKey,recipient:auth.derivedAddress,accessType},{headers:HEADERS});
                }
                if(request.operation==="revoke-approve"){
                    if(!request.approvalId||!request.walletSignature)throw new MySoAccessError(400,"Access-revocation approval ID and owner signature are required");
                    const approved=await auth.mcp.callTool("chain_approve_action",{approvalId:request.approvalId,walletSignature:request.walletSignature},req.signal);
                    if(!approved.ok)throw new MySoAccessError(409,"The owner signature was not accepted for the exact agent access revocation");
                    return Response.json({approved:true},{headers:HEADERS});
                }
                if(request.operation==="revoke-prepare"){
                    if(!request.approvalId)throw new MySoAccessError(400,"Approved access-revocation reference is required");
                    const prepared=await auth.mcp.callTool("chain_prepare_approved_action",{registryAction,parameters,idempotencyKey:request.idempotencyKey,approvalId:request.approvalId},req.signal);
                    if(!prepared.ok)throw new MySoAccessError(409,"The exact owner-approved agent access revocation could not be prepared");
                    const transaction=z.object({bytes:z.string().min(1),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).passthrough().parse(prepared.data);
                    return Response.json({approvalId:request.approvalId,bytes:transaction.bytes,digest:transaction.digest,recipient:auth.derivedAddress,accessType},{headers:HEADERS});
                }
                if(request.operation==="revoke-submit"){
                    if(!request.approvalId||!request.digest||!request.walletSignature)throw new MySoAccessError(400,"Approval, transaction digest and owner signature are required");
                    const submitted=await auth.mcp.callTool("chain_submit_approved_action",{registryAction,idempotencyKey:request.idempotencyKey,approvalId:request.approvalId,digest:request.digest,walletSignature:request.walletSignature},req.signal);
                    if(!submitted.ok)throw new MySoAccessError(409,"The signed agent access revocation was not accepted; check chain status before retrying");
                    return Response.json({submitted:true,transaction:submitted.data},{headers:HEADERS});
                }
                if(!request.digest)throw new MySoAccessError(400,"Access-revocation transaction digest is required");
                const result=await auth.mcp.callTool("mydata_get_owner_access_receipt",{id:request.digest},req.signal);
                if(!result.ok)throw new MySoAccessError(409,"The owner access-revocation receipt is not finalized yet");
                const evidence=z.object({digest:z.string(),registryAction:z.literal(registryAction),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().nullable(),events:z.array(z.object({kind:z.literal("AccessRevokedEvent"),mydataId:z.string(),recipient:z.string(),accessType:z.enum(["one_time","subscription","all"])}).passthrough())}).passthrough().parse(result.data);
                const expectedAccess=request.accessKind===2?"one_time":"subscription";
                if(evidence.digest!==request.digest||evidence.status!=="finalized"||!evidence.checkpoint||!evidence.events.some(event=>sameId(event.mydataId,request.mydataId!)&&sameId(event.recipient,auth.derivedAddress)&&event.accessType===expectedAccess))throw new MySoAccessError(409,"A finalized revocation for this exact listing and authenticated agent was not found");
                return Response.json({receipt:evidence,verification:"finalized_owner_revocation_for_authenticated_agent",previouslyDisclosedDataErased:false},{headers:HEADERS});
            }
            if(request.operation==="grant-approve"){
                if(!request.approvalId||!request.walletSignature)throw new MySoAccessError(400,"The access-grant approval and owner signature are required");
                const approved=await auth.mcp.callTool("chain_approve_action",{approvalId:request.approvalId,walletSignature:request.walletSignature},req.signal);
                if(!approved.ok)throw new MySoAccessError(409,"The owner signature was not accepted for the exact agent access grant");
                return Response.json({approved:true},{headers:HEADERS});
            }
            if(request.operation==="grant-submit"){
                if(!request.approvalId||!request.idempotencyKey||!request.digest||!request.walletSignature||!request.mydataId||!request.audienceKind)throw new MySoAccessError(400,"Access-grant submission fields are incomplete");
                if(request.audienceKind!=="agent")throw new MySoAccessError(400,"An organization-audience purchase uses its on-chain organization grant, not a per-agent grant");
                const submitted=await auth.mcp.callTool("chain_submit_approved_action",{registryAction:"access.share_mydata.v1",idempotencyKey:request.idempotencyKey,approvalId:request.approvalId,digest:request.digest,walletSignature:request.walletSignature},req.signal);
                if(!submitted.ok)throw new MySoAccessError(409,"The signed agent access grant was not accepted; check chain status before retrying");
                return Response.json({submitted:true,transaction:submitted.data},{headers:HEADERS});
            }
            if(request.operation==="grant-receipt"){
                if(!request.digest||!request.mydataId||request.audienceKind!=="agent"||!request.accessKind)throw new MySoAccessError(400,"Access-grant digest, listing, and agent audience are required");
                const grantDigest=request.digest;const mydataId=request.mydataId;const accessKind=request.accessKind;const receipt=await auth.mcp.callTool("mydata_get_owner_access_receipt",{id:grantDigest},req.signal);if(!receipt.ok)throw new MySoAccessError(409,"The owner-grant receipt is not finalized yet");
                const result=z.object({digest:z.string(),registryAction:z.literal("access.share_mydata.v1"),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().nullable(),events:z.array(z.object({kind:z.literal("AccessGrantedEvent"),mydataId:z.string(),recipient:z.string(),accessType:z.enum(["one_time","subscription"])}).passthrough())}).passthrough().parse(receipt.data);
                if(result.digest!==grantDigest||result.status!=="finalized"||!result.checkpoint||!result.events.some(event=>sameId(event.mydataId,mydataId)&&sameId(event.recipient,auth.derivedAddress)&&event.accessType===(accessKind===3?"subscription":"one_time")))throw new MySoAccessError(409,"A finalized owner grant to this exact agent and graph was not found");
                return Response.json({receipt:result,verification:"finalized_owner_grant_to_agent"},{headers:HEADERS});
            }
            if(request.operation==="grant-request"||request.operation==="grant-prepare"){
                if(!request.digest||!request.mydataId||request.audienceKind!=="agent"||!request.idempotencyKey||!request.graphId||!request.graphVersion||!request.manifestHashHex||!request.paymentCoinId)throw new MySoAccessError(400,"A finalized agent-audience purchase is required before granting the selected agent access");
                const mydataId=request.mydataId;const purchased=await auth.mcp.callTool("mydata_get_purchase_receipt",{id:request.digest},req.signal);if(!purchased.ok)throw new MySoAccessError(409,"The finalized owner purchase is unavailable before the access grant");
                const purchaseEvidence=z.object({digest:z.string(),status:z.string(),checkpoint:z.string().nullable(),receipts:z.array(z.object({mydataId:z.string(),buyerAddress:z.string(),buyerAccountId:z.string(),buyerAgentId:z.string().nullable(),buyerExecution:z.string(),organizationAudienceId:z.string().nullable(),seller:z.string(),accessKind:z.number().int(),priceMist:z.string(),durationDays:z.string(),purchasedAtMs:z.string(),encryptedDataDigestHex:z.string()}).passthrough())}).passthrough().parse(purchased.data);
                const ownerPurchase=purchaseEvidence.receipts.find(item=>sameId(item.mydataId,mydataId)&&item.buyerExecution==="owner_approved"&&sameId(item.buyerAddress,auth.scope.owner)&&sameId(item.buyerAccountId,auth.scope.accountId)&&item.buyerAgentId===null&&!item.organizationAudienceId);
                if(purchaseEvidence.digest!==request.digest||purchaseEvidence.status!=="finalized"||!purchaseEvidence.checkpoint||!ownerPurchase)throw new MySoAccessError(409,"Only a finalized owner purchase for this account and the explicit agent audience can fund this access grant");
                const quoteResult=await auth.mcp.callTool("mydata_get_purchase_quote",{id:request.mydataId},req.signal);if(!quoteResult.ok)throw new MySoAccessError(409,"The listing quote is unavailable for exact access-grant terms");
                const quote=myDataQuoteSchema.parse(quoteResult.data);if(quote.mediaType!=="application/vnd.mysocial.graph-manifest+json;version=1"||!sameId(quote.buyerAddress,auth.derivedAddress))throw new MySoAccessError(502,"The graph quote is not the expected GraphManifest for this authenticated agent");
                let subscriptionDays:string|undefined;
                if(quote.purchaseParameters.accessKind===3){const originalEnd=BigInt(ownerPurchase.purchasedAtMs)+BigInt(ownerPurchase.durationDays)*86_400_000n;const remaining=originalEnd-BigInt(Date.now());const maximumDays=remaining>0n?remaining/86_400_000n:0n;if(maximumDays<1n)throw new MySoAccessError(409,"The purchased subscription has less than one full day remaining; renew access before granting the agent a subscription");if(request.operation==="grant-request")subscriptionDays=maximumDays.toString();else{if(!request.shareDurationDays||BigInt(request.shareDurationDays)>maximumDays)throw new MySoAccessError(409,"The purchase's remaining subscription period changed; request a fresh owner grant");subscriptionDays=request.shareDurationDays;}}
                else if(request.shareDurationDays!==undefined)throw new MySoAccessError(400,"A one-time access grant cannot include a subscription period");
                const params={mydataId:request.mydataId,recipient:quote.buyerAddress,accessType:quote.purchaseParameters.accessKind===2?0:1,...(subscriptionDays?{subscriptionDays}:{})};
                if(!sameId(ownerPurchase.seller,quote.purchaseParameters.expectedSeller)||ownerPurchase.accessKind!==quote.purchaseParameters.accessKind||ownerPurchase.priceMist!==quote.purchaseParameters.priceMist||ownerPurchase.durationDays!==quote.purchaseParameters.durationDays||ownerPurchase.encryptedDataDigestHex!==quote.purchaseParameters.encryptedDataDigestHex)throw new MySoAccessError(409,"The owner purchase no longer matches the quoted graph terms");
                if(request.operation==="grant-request"){
                    let grantKey=request.idempotencyKey;let action=await auth.mcp.callTool("chain_request_action_approval",{registryAction:"access.share_mydata.v1",parameters:params,idempotencyKey:grantKey,expiresInSeconds:600},req.signal);if(!action.ok)throw new MySoAccessError(409,"Exact agent access approval could not be requested; verify social:write and social:approve");
                    const approvalSchema=z.object({approvalId:z.string().uuid().optional(),approval_id:z.string().uuid().optional(),approvalIntent:z.string().optional(),approval_intent:z.string().optional(),status:z.string().optional(),expiresAtMs:z.number().optional(),expires_at_ms:z.number().optional()}).passthrough();let parsed=approvalSchema.parse(action.data);const expiry=parsed.expiresAtMs??parsed.expires_at_ms;
                    if(parsed.status==="expired"||(expiry!==undefined&&expiry<=Date.now())){grantKey=`graph-grant:${randomUUID()}`;action=await auth.mcp.callTool("chain_request_action_approval",{registryAction:"access.share_mydata.v1",parameters:params,idempotencyKey:grantKey,expiresInSeconds:600},req.signal);if(!action.ok)throw new MySoAccessError(409,"A fresh agent access approval could not be requested");parsed=approvalSchema.parse(action.data);}
                    const approvalId=parsed.approvalId??parsed.approval_id;const approvalIntent=parsed.approvalIntent??parsed.approval_intent;if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"The access approval response omitted its signature intent");
                    return Response.json({approvalId,approvalIntent,idempotencyKey:grantKey,recipient:quote.buyerAddress,accessType:params.accessType,subscriptionDays},{headers:HEADERS});
                }
                if(!request.approvalId)throw new MySoAccessError(400,"Approved access grant reference is required");
                const prepared=await auth.mcp.callTool("chain_prepare_approved_action",{registryAction:"access.share_mydata.v1",parameters:params,idempotencyKey:request.idempotencyKey,approvalId:request.approvalId},req.signal);if(!prepared.ok)throw new MySoAccessError(409,"The exact owner-approved agent access grant could not be prepared");
                const transaction=z.object({bytes:z.string().min(1),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)}).passthrough().parse(prepared.data);return Response.json({approvalId:request.approvalId,bytes:transaction.bytes,digest:transaction.digest,recipient:quote.buyerAddress,accessType:params.accessType},{headers:HEADERS});
            }
            const {mydataId,graphId,graphVersion,manifestHashHex,audienceKind,organizationAudienceId,paymentCoinId,idempotencyKey}=request;
            if(!mydataId||!graphId||!graphVersion||!manifestHashHex||!audienceKind||!paymentCoinId||!idempotencyKey)throw new MySoAccessError(400,"A verified graph version, audience, MYSO coin and idempotency key are required");
            if(audienceKind==="organization"&&(!organizationAudienceId||!auth.scope.organizationId||!sameId(organizationAudienceId,auth.scope.organizationId)))throw new MySoAccessError(403,"Choose the connected organization this agent is authorized to represent");
            if(audienceKind==="agent"&&organizationAudienceId)throw new MySoAccessError(400,"An agent-audience purchase cannot include an organization audience");
            const verified=await auth.mcp.callTool("mydata_verify_graph_offer",{request:{mydataId}},req.signal);
            if(!verified.ok)throw new MySoAccessError(409,"The seller proof or current listing quote can no longer be verified");
            const proof=myDataGraphOfferProofSchema.parse(verified.data);
            if(proof.publication.offerTerms.entitlement!=="pinned_version")throw new MySoAccessError(409,"This MyData protocol can purchase one immutable graph version at a time; ask the seller to publish a pinned-version offer");
            if(proof.publication.graphId!==graphId||proof.publication.graphVersion!==graphVersion||proof.manifestHashHex!==manifestHashHex||proof.publication.manifestHashHex!==manifestHashHex||!proof.quote.deploymentEnabled)throw new MySoAccessError(409,"The verified graph version or manifest changed; review the current offer again");
            if(request.operation==="request"||request.operation==="prepare"){
                if(request.buyerAcceptedOfferTerms!==true)throw new MySoAccessError(400,"The buyer must explicitly accept the seller-signed graph access terms before purchase");
                if(request.acceptedPublicationSignatureHex!==proof.publication.signatureHex)throw new MySoAccessError(409,"The buyer acceptance does not match the currently verified seller publication; review the offer again");
            }
            const coins=await auth.mcp.callTool("payments_list_coins",{coinType:"0x2::myso::MYSO",limit:50},req.signal);
            if(!coins.ok)throw new MySoAccessError(403,"Owner wallet MYSO coins are unavailable; verify payments:read access");
            const coinPage=z.object({data:z.array(z.object({coinObjectId:z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),balanceBaseUnits:z.string().regex(/^(0|[1-9][0-9]*)$/)}).passthrough())}).passthrough().parse(coins.data);
            const coin=coinPage.data.find(item=>sameId(item.coinObjectId,paymentCoinId));
            if(!coin||BigInt(coin.balanceBaseUnits)<BigInt(proof.quote.purchaseParameters.priceMist))throw new MySoAccessError(409,"Select a currently owned MYSO coin with enough balance for the exact quoted price");
            const parameters={...proof.quote.purchaseParameters,paymentCoinId,audienceKind,...(audienceKind==="organization"?{organizationAudienceId}: {}),graphId,graphVersion:String(graphVersion),manifestHashHex,publicationSignatureHex:proof.publication.signatureHex};
            const terms={mydataId,graphId,graphVersion,manifestHashHex,audienceKind,organizationAudienceId,priceMist:proof.quote.purchaseParameters.priceMist,accessKind:proof.quote.purchaseParameters.accessKind,durationDays:proof.quote.purchaseParameters.durationDays,seller:proof.quote.purchaseParameters.expectedSeller,paymentCoinId};
            if(request.operation==="request"){
                const approval=await auth.mcp.callTool("chain_request_action_approval",{registryAction:"access.purchase_mydata_access.v1",parameters,idempotencyKey,expiresInSeconds:600},req.signal);
                if(!approval.ok)throw new MySoAccessError(409,"Owner approval could not be requested; confirm social:write and social:approve permissions and the current purchase policy");
                const parsed=z.object({approval_id:z.string().uuid().optional(),approvalId:z.string().uuid().optional(),approval_intent:z.string().min(1).optional(),approvalIntent:z.string().min(1).optional(),status:z.string().optional(),expires_at_ms:z.number().optional(),expiresAtMs:z.number().optional()}).passthrough().parse(approval.data);
                const approvalId=parsed.approvalId??parsed.approval_id;const approvalIntent=parsed.approvalIntent??parsed.approval_intent;
                if(!approvalId||!approvalIntent)throw new MySoAccessError(502,"Owner approval response omitted the exact approval intent");
                return Response.json({approvalId,approvalIntent,expiresAtMs:parsed.expiresAtMs??parsed.expires_at_ms,terms},{headers:HEADERS});
            }
            if(request.operation!=="prepare"||!request.approvalId)throw new MySoAccessError(400,"The approved purchase reference is required to prepare the transaction");
            const approvalId=request.approvalId;
            const prepared=await auth.mcp.callTool("chain_prepare_approved_action",{registryAction:"access.purchase_mydata_access.v1",parameters,idempotencyKey,approvalId},req.signal);
            if(!prepared.ok)throw new MySoAccessError(409,"The owner-approved graph purchase could not be sponsored or simulated");
            const transaction=z.object({bytes:z.string().min(1),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),expires_at_ms:z.number().optional(),expiresAtMs:z.number().optional()}).passthrough().parse(prepared.data);
            return Response.json({approvalId,expiresAtMs:transaction.expiresAtMs??transaction.expires_at_ms,bytes:transaction.bytes,digest:transaction.digest,terms},{headers:HEADERS});
        }
        if(kind==="graph-search"){
            const asked=mySoGraphSearchRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_search_graph",{request:asked},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Private graph content is unavailable with your current access and session");
            if(Buffer.byteLength(JSON.stringify(result.data),"utf8")>1_000_000)throw new MySoAccessError(502,"The graph search response exceeds the display limit");
            const parsed=mySoGraphSearchResultSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The graph search service returned an unsupported response");const graph=parsed.data;
            if(!sameId(graph.mydataId,asked.mydataId)||graph.encryptedDataDigestHex!==asked.encryptedDataDigestHex||graph.query!==asked.query.trim()
                ||!sameId(graph.access.accountId,auth.scope.accountId)||!sameId(graph.access.agentId,auth.scope.agentId)||graph.access.network!==auth.scope.network
                ||(asked.organizationAudienceId?(!graph.access.organizationAudienceId||!sameId(graph.access.organizationAudienceId,asked.organizationAudienceId)):!!graph.access.organizationAudienceId))throw new MySoAccessError(502,"The graph response did not match this account and request");
            return Response.json(graph,{headers:HEADERS});
        }
        if(kind==="graph-item"){
            const asked=mySoGraphItemRequestSchema.parse(raw);
            const result=await auth.mcp.callTool("mydata_get_graph_item",{request:asked},req.signal);
            if(!result.ok)throw new MySoAccessError(403,"Private graph content is unavailable with your current access and session");
            if(Buffer.byteLength(JSON.stringify(result.data),"utf8")>750_000)throw new MySoAccessError(502,"The graph item response exceeds the display limit");
            const parsed=mySoGraphItemResultSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The graph item service returned an unsupported response");const graph=parsed.data;
            if(!sameId(graph.mydataId,asked.mydataId)||graph.encryptedDataDigestHex!==asked.encryptedDataDigestHex||graph.kind!==asked.kind||graph.item.id!==asked.id
                ||!sameId(graph.access.accountId,auth.scope.accountId)||!sameId(graph.access.agentId,auth.scope.agentId)||graph.access.network!==auth.scope.network
                ||(asked.organizationAudienceId?(!graph.access.organizationAudienceId||!sameId(graph.access.organizationAudienceId,asked.organizationAudienceId)):!!graph.access.organizationAudienceId))throw new MySoAccessError(502,"The graph item did not match this account and request");
            return Response.json(graph,{headers:HEADERS});
        }
        const asked=myDataContentRequestSchema.parse(raw);
        const result=await auth.mcp.callTool("mydata_read_content",{request:asked},req.signal);
        if(!result.ok)throw new MySoAccessError(403,"Private content is unavailable with your current access and session");
        const parsed=myDataContentPageSchema.safeParse(result.data);if(!parsed.success)throw new MySoAccessError(502,"The content service returned an unsupported page");const page=parsed.data;
        const count=page.format==="utf8"?Array.from(page.data).length:Buffer.from(page.data,"base64").length;
        const next=page.offset+count;
        if(count>asked.limit||next>page.total||page.offsetUnit!==(page.format==="utf8"?"unicode_scalar":"byte")||page.hasNext!==(next<page.total)||page.nextOffset!==(next<page.total?next:null)
            ||(page.format==="base64"&&Buffer.from(page.data,"base64").toString("base64")!==page.data))throw new MySoAccessError(502,"The content service returned an invalid page range");
        if(!sameId(page.mydataId,asked.mydataId)||page.encryptedDataDigestHex!==asked.encryptedDataDigestHex||page.offset!==asked.offset||page.format!==asked.format
            ||!sameId(page.access.accountId,auth.scope.accountId)||!sameId(page.access.agentId,auth.scope.agentId)||page.access.network!==auth.scope.network
            ||(asked.organizationAudienceId?(!page.access.organizationAudienceId||!sameId(page.access.organizationAudienceId,asked.organizationAudienceId)):!!page.access.organizationAudienceId))throw new MySoAccessError(502,"The content response did not match this account and request");
        return Response.json(page,{headers:HEADERS});
    }catch(error){
        if(error instanceof z.ZodError)return Response.json({error:"The private-data request or response has an unsupported format"},{status:400,headers:HEADERS});
        return mySoErrorResponse(error);
    }
}
