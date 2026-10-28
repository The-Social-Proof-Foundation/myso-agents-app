import { z } from "zod";
import { decimalMistSchema } from "./work.ts";
const id=z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
export const myDataQuoteRequestSchema=z.object({mydataId:id}).strict();
export const myDataListingsRequestSchema=z.object({limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(100000).default(0)}).strict();
const myDataPurchaseHistoryItemSchema=z.object({id:z.number().int().nonnegative(),mydata_id:id,buyer:id,purchase_type:z.string().min(1).max(64),purchase_time:z.number().int().nonnegative(),time:z.string().datetime(),transaction_id:z.string().min(1).max(128),revoked:z.boolean(),revoked_at:z.number().int().nonnegative().nullable(),revoked_by:id.nullable()}).passthrough();
export const myDataPurchaseHistorySchema=z.object({ownerAddress:id,agentAddress:id,ownerPurchases:z.array(myDataPurchaseHistoryItemSchema).max(100),agentPurchases:z.array(myDataPurchaseHistoryItemSchema).max(100),limit:z.number().int().min(1).max(100),offset:z.number().int().min(0).max(100000),hasMore:z.boolean(),nextOffset:z.number().int().min(1).max(100100).nullable(),notice:z.string().max(512)}).strict().superRefine((page,ctx)=>{
    if(page.hasMore!==(page.nextOffset!==null))ctx.addIssue({code:"custom",path:["nextOffset"],message:"purchase history continuation does not match hasMore"});
    if(page.nextOffset!==null&&page.nextOffset!==page.offset+page.limit)ctx.addIssue({code:"custom",path:["nextOffset"],message:"purchase history continuation must advance by the page limit"});
    if(page.ownerPurchases.length>page.limit||page.agentPurchases.length>page.limit)ctx.addIssue({code:"custom",message:"purchase history page exceeds the requested limit"});
});
export const myDataPurchaseReceiptSchema=z.object({digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),receipts:z.array(z.object({mydataId:id,buyerAddress:id,buyerAccountId:id,buyerAgentId:id.nullable(),buyerExecution:z.enum(["owner_approved","agent_automated"]),organizationAudienceId:id.nullable(),seller:id,postId:id.nullable(),accessKind:z.union([z.literal(2),z.literal(3)]),priceMist:decimalMistSchema,durationDays:decimalMistSchema,encryptedDataDigestHex:z.string().regex(/^[0-9a-f]{64}$/),encryptionIdDigestHex:z.string().regex(/^[0-9a-f]{64}$/),listingPlatformId:id.nullable(),feePlatformId:id,purchasedAtMs:decimalMistSchema,graphSnapshot:z.object({graphId:z.string().min(1).max(128),graphVersion:decimalMistSchema,manifestHashHex:z.string().regex(/^[0-9a-f]{64}$/),publicationSignatureDigestHex:z.string().regex(/^[0-9a-f]{64}$/),organizationId:id.nullable()}).nullable().optional()}).passthrough()).max(100),evidenceSource:z.literal("configured_fullnode"),currentAccess:z.literal("not_checked")}).passthrough();
export const myDataOwnerAccessHistorySchema=z.object({accountId:id,agentId:id,ownerAddress:id,agentAddress:id,entries:z.array(z.object({registryAction:z.enum(["access.share_mydata.v1","access.revoke_mydata_share.v1"]),actionStatus:z.enum(["preparing","sponsored","submitting","executed","failed"]),digest:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).nullable(),createdAt:z.string(),chainReceipt:z.object({digest:z.string(),registryAction:z.enum(["access.share_mydata.v1","access.revoke_mydata_share.v1"]),status:z.enum(["finalized","executed","failed","unknown"]),checkpoint:z.string().nullable(),events:z.array(z.object({kind:z.enum(["AccessGrantedEvent","AccessRevokedEvent"]),mydataId:id,recipient:id,owner:id,accessType:z.enum(["one_time","subscription","all"]),timestampMs:decimalMistSchema}).passthrough())}).passthrough().nullable()}).passthrough()).max(50),limit:z.number().int().min(1).max(50),offset:z.number().int().min(0).max(100000),hasMore:z.boolean(),evidenceSource:z.literal("authenticated_action_journal_and_configured_fullnode"),notice:z.string().max(1024)}).strict();
export const myDataListingPageSchema=z.object({
    listings:z.array(z.object({mydataId:id,owner:id,mediaType:z.string().max(80),tags:z.array(z.string().max(80)).max(20),oneTimePriceMist:decimalMistSchema.nullable(),subscriptionPriceMist:decimalMistSchema.nullable(),subscriptionDurationDays:decimalMistSchema,createdAt:decimalMistSchema}).strict()).max(50),
    offset:z.number().int().min(0).max(100000),scannedCount:z.number().int().min(0).max(50),nextOffset:z.number().int().positive().max(100050).nullable(),
}).strict();
const graphOfferSchema=z.object({mydataId:id,owner:id,mediaType:z.enum(["application/vnd.mysocial.knowledge-graph+json;version=1","application/vnd.mysocial.graph-manifest+json;version=1"]),schemaVersion:z.enum(["myso.knowledge-graph.v1","myso.graph-manifest.v1"]),tags:z.array(z.string().max(80)).max(20),oneTimePriceMist:decimalMistSchema.nullable(),subscriptionPriceMist:decimalMistSchema.nullable(),subscriptionDurationDays:decimalMistSchema,createdAt:decimalMistSchema}).strict().superRefine((offer,ctx)=>{
    const valid=(offer.mediaType==="application/vnd.mysocial.knowledge-graph+json;version=1"&&offer.schemaVersion==="myso.knowledge-graph.v1")||(offer.mediaType==="application/vnd.mysocial.graph-manifest+json;version=1"&&offer.schemaVersion==="myso.graph-manifest.v1");
    if(!valid)ctx.addIssue({code:"custom",message:"Graph media type and schema version do not match"});
});
export const myDataGraphOfferPageSchema=z.object({
    offers:z.array(graphOfferSchema).max(50),
    offset:z.number().int().min(0).max(100000),scannedCount:z.number().int().min(0).max(50),nextOffset:z.number().int().positive().max(100050).nullable(),
    mediaType:z.literal("application/vnd.mysocial.graph-offer-preview.v1"),
}).strict();
export const myDataContentRequestSchema=z.object({mydataId:id,encryptedDataDigestHex:z.string().regex(/^[0-9a-f]{64}$/),format:z.enum(["utf8","base64"]),offset:z.number().int().min(0).max(262144),limit:z.number().int().min(1).max(8000),organizationAudienceId:id.optional()}).strict();
export const myDataQuoteSchema=z.object({
    mydataId:id,buyerAddress:id,objectVersion:decimalMistSchema,mediaType:z.string().min(1).max(1024),tags:z.array(z.string().max(64)).max(10),deploymentEnabled:z.boolean(),
    purchaseParameters:z.object({mydataId:id,expectedSeller:id,accessKind:z.union([z.literal(2),z.literal(3)]),priceMist:decimalMistSchema,durationDays:decimalMistSchema,encryptionIdHex:z.string().regex(/^(?:[0-9a-f]{2}){1,1024}$/),encryptedDataDigestHex:z.string().regex(/^[0-9a-f]{64}$/),expectedListingPlatformId:id.optional()}),
});
export const myDataGraphOfferProofSchema=z.object({
    quote:myDataQuoteSchema, manifestHashHex:z.string().regex(/^[0-9a-f]{64}$/), verification:z.literal("pre_purchase_seller_proof"),
    publication:z.object({schemaVersion:z.literal("myso.graph-publication.v1"),sellerAddress:id,sellerPublicKeyHex:z.string().regex(/^[0-9a-f]{64}$/),manifestHashHex:z.string().regex(/^[0-9a-f]{64}$/),graphId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),graphVersion:z.number().int().positive().optional(),publishedAtMs:z.number().int().nonnegative(),
        authorityProof:z.object({kind:z.enum(["organization_admin","sell_graph_delegate"]),organizationId:id,delegateId:id.optional(),capability:z.literal("sell_graph"),checkedAtMs:z.number().int().nonnegative()}).strict(),
        offerTerms:z.object({accessKind:z.union([z.literal(2),z.literal(3)]),priceMist:decimalMistSchema,durationDays:decimalMistSchema,revocationPolicy:z.enum(["one_time_perpetual","subscription_period_end","subscription_early_future_only"]),entitlement:z.literal("pinned_version"),audiencePolicy:z.literal("buyer_agent_or_explicit_org")}).strict(),
        signatureHex:z.string().regex(/^[0-9a-f]{128}$/)}).strict().superRefine((publication,ctx)=>{if((publication.graphId===undefined)!==(publication.graphVersion===undefined))ctx.addIssue({code:"custom",message:"Graph publication identity must be complete"});}),
}).strict();
export const myDataContentPageSchema=z.object({
    mydataId:id,encryptedDataDigestHex:z.string().regex(/^[0-9a-f]{64}$/),objectVersion:decimalMistSchema,
    data:z.string().max(32000),format:z.enum(["utf8","base64"]),offset:z.number().int().min(0).max(262144),offsetUnit:z.enum(["unicode_scalar","byte"]),
    total:z.number().int().min(0).max(262144),nextOffset:z.number().int().positive().max(262144).nullable(),hasNext:z.boolean(),
    access:z.object({source:z.literal("current_key_server_policy"),callerAddress:id,accountId:id,agentId:id,network:z.enum(["mainnet","testnet","devnet","localnet"]),sharedDerivedKeyCache:z.literal(false),organizationAudienceId:id.optional(),purchaseQuote:z.object({expectedSeller:id,mediaType:z.string().min(1).max(1024),tags:z.array(z.string().max(64)).max(10),accessKind:z.union([z.literal(2),z.literal(3)]),priceMist:decimalMistSchema,durationDays:decimalMistSchema}).strict().optional()}),
});
export type MyDataQuote=z.infer<typeof myDataQuoteSchema>;
export type MyDataGraphOfferProof=z.infer<typeof myDataGraphOfferProofSchema>;
export type MyDataListingPage=z.infer<typeof myDataListingPageSchema>;
export type MyDataGraphOfferPage=z.infer<typeof myDataGraphOfferPageSchema>;
export type MyDataContentPage=z.infer<typeof myDataContentPageSchema>;
export type MyDataContentRequest=z.infer<typeof myDataContentRequestSchema>;
export type MyDataPurchaseHistory=z.infer<typeof myDataPurchaseHistorySchema>;
export type MyDataPurchaseReceipt=z.infer<typeof myDataPurchaseReceiptSchema>;
export type MyDataOwnerAccessHistory=z.infer<typeof myDataOwnerAccessHistorySchema>;
