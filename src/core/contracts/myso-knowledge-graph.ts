import { z } from "zod";

const graphId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const orgId = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const graphState = z.enum(["asserted", "verified", "disputed", "superseded", "revoked"]);
const node = z.object({ id: graphId, kind: z.enum(["concept", "person", "organization", "task", "claim", "artifact", "room"]), label: z.string().min(1).max(500), statement: z.string().max(4096), aliases: z.array(z.string().max(512)).max(100), evidenceIds: z.array(graphId).max(500), state: graphState }).strict();
const edge = z.object({ id: graphId, kind: z.enum(["related_to", "supports", "contradicts", "depends_on", "assigned_to", "member_of", "participates_in", "references", "derived_from", "created_by", "delivered_to", "published_in", "owns", "completed_by", "originates_from"]), sourceId: graphId, targetId: graphId, evidenceIds: z.array(graphId).max(500), state: graphState }).strict();
const evidence = z.object({ id: graphId, kind: z.enum(["task_receipt", "action_receipt", "artifact", "room_message", "owner_assertion", "external_source"]), sourceId: z.string().min(1).max(2048), sourceVersion: z.string().min(1).max(256), digestHex: z.string().regex(/^[0-9a-f]{64}$/).optional(), receiptId: z.string().max(256).optional(), artifactId: z.string().max(256).optional(), visibility: z.enum(["private", "organization", "room"]), derivationEvidenceIds: z.array(graphId).max(500), state: graphState, recordedAt: z.string().datetime() }).strict();
const provenance = z.object({ id: graphId, subjectType: z.enum(["node", "edge"]), subjectId: graphId, evidenceId: graphId, actor: z.enum(["owner", "agent", "system"]), recordedAt: z.string().datetime(), state: graphState }).strict();

const graphManifest = z.object({
    schemaVersion: z.literal("myso.graph-manifest.v1"), graphId, graphVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: z.string().min(1).max(500),
    entities: z.array(node).max(20_000), relations: z.array(edge).max(40_000), evidenceRefs: z.array(evidence).max(20_000), provenance: z.array(provenance).max(20_000),
    coverageKeys: z.array(z.string().min(1).max(256)).max(20_000), encryptionEnvelopeRefs: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)).max(10_000),
    sourceRights: z.array(z.object({ entityId: graphId, evidenceRefIds: z.array(graphId).max(500), sourceOwnerAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), license: z.string().min(1).max(256), permissions: z.array(z.enum(["read", "derive", "publish", "sell_graph"])).min(1).max(4), expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).strict()).max(2_000),
}).strict();

const graphOfferTerms = z.object({
    accessKind: z.union([z.literal(2), z.literal(3)]), priceMist: z.string().regex(/^[1-9][0-9]{0,19}$/), durationDays: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    revocationPolicy: z.enum(["one_time_perpetual", "subscription_period_end", "subscription_early_future_only"]), entitlement: z.literal("pinned_version"),
    audiencePolicy: z.literal("buyer_agent_or_explicit_org"),
}).strict().superRefine((terms, context) => {
    const duration = BigInt(terms.durationDays);
    if ((terms.accessKind === 2 && (duration !== 0n || terms.revocationPolicy !== "one_time_perpetual"))
        || (terms.accessKind === 3 && (duration === 0n || terms.revocationPolicy === "one_time_perpetual"))) context.addIssue({ code: "custom", message: "Graph offer terms conflict with the selected MyData access model" });
});

export const mySoGraphManifestSchema = graphManifest;
export const mySoGraphPublishRequestSchema = z.object({
    manifest: graphManifest,
    authorityProof: z.object({ kind: z.enum(["organization_admin", "sell_graph_delegate"]), organizationId: orgId, delegateId: orgId.optional(), checkedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
    offerTerms: graphOfferTerms,
    publishedAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:/-]{8,128}$/),
}).strict().superRefine((value, context) => {
    if (value.authorityProof.kind === "organization_admin" && value.authorityProof.delegateId !== undefined) context.addIssue({ code: "custom", message: "An organization-admin proof cannot include a delegate ID" });
});
export type MySoGraphPublishRequest = z.infer<typeof mySoGraphPublishRequestSchema>;

export const mySoGraphSearchRequestSchema = z.object({ mydataId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), encryptedDataDigestHex: z.string().regex(/^[0-9a-f]{64}$/), query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(20).optional(), kinds: z.array(node.shape.kind).max(7).optional(), organizationAudienceId: orgId.optional() }).strict();
export const mySoGraphItemRequestSchema = z.object({ mydataId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), encryptedDataDigestHex: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(["node", "edge", "evidence"]), id: graphId, organizationAudienceId: orgId.optional() }).strict();
const address = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const publication = z.object({
    schemaVersion: z.literal("myso.graph-publication.v1"), sellerAddress: address, sellerPublicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
    manifestHashHex: z.string().regex(/^[0-9a-f]{64}$/), graphId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(), graphVersion: z.number().int().positive().optional(), publishedAtMs: z.number().int().nonnegative(),
    authorityProof: z.object({ kind: z.enum(["organization_admin", "sell_graph_delegate"]), organizationId: address, delegateId: address.optional(), capability: z.literal("sell_graph"), checkedAtMs: z.number().int().nonnegative() }).strict(),
    offerTerms: z.object({ accessKind: z.union([z.literal(2), z.literal(3)]), priceMist: z.string().regex(/^[1-9][0-9]{0,19}$/), durationDays: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), revocationPolicy: z.enum(["one_time_perpetual", "subscription_period_end", "subscription_early_future_only"]), entitlement: z.literal("pinned_version"), audiencePolicy: z.literal("buyer_agent_or_explicit_org") }).strict(),
    signatureHex: z.string().regex(/^[0-9a-f]{128}$/),
}).strict().superRefine((value, context) => {
    if ((value.graphId === undefined) !== (value.graphVersion === undefined)) context.addIssue({ code: "custom", message: "Graph publication identity must include both graphId and graphVersion" });
});
const graphAccess = z.object({ source: z.literal("current_key_server_policy"), callerAddress: address, accountId: address, agentId: address, network: z.enum(["mainnet", "testnet", "devnet", "localnet"]), sharedDerivedKeyCache: z.literal(false), organizationAudienceId: orgId.optional(), purchaseQuote: z.object({ expectedSeller: address, mediaType: z.string().min(1).max(1024), tags: z.array(z.string().max(64)).max(10), accessKind: z.union([z.literal(2), z.literal(3)]), priceMist: z.string().regex(/^[1-9][0-9]{0,19}$/), durationDays: z.string().regex(/^(0|[1-9][0-9]{0,19})$/) }).strict().optional() }).strict();
export const mySoGraphItemResultSchema = z.object({
    mydataId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), encryptedDataDigestHex: z.string().regex(/^[0-9a-f]{64}$/), graphId, graphVersion: z.number().int().positive(),
    kind: z.enum(["node", "edge", "evidence"]), item: z.union([node, edge, evidence]), nodes: z.array(node).max(100), edges: z.array(edge).max(200), evidence: z.array(evidence).max(500), provenance: z.array(provenance).max(20000),
    access: graphAccess, verifiedPublication: publication.optional(), evidenceNotice: z.literal("Graph assertions are private content; verified state is a label and does not replace independent receipt verification."),
}).strict();
export const mySoGraphSearchResultSchema = z.object({
    mydataId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/), encryptedDataDigestHex: z.string().regex(/^[0-9a-f]{64}$/), graphId, graphVersion: z.number().int().positive(), query: z.string().max(200),
    matches: z.array(z.object({ node, edges: z.array(edge).max(10000), evidence: z.array(evidence).max(10000), provenance: z.array(provenance).max(20000) }).strict()).max(20),
    access: graphAccess, verifiedPublication: publication.optional(),
    evidenceNotice: z.literal("Graph assertions are private content; verified state is a label and does not replace independent receipt verification."),
}).strict();
export type MySoGraphSearchRequest = z.infer<typeof mySoGraphSearchRequestSchema>;
export type MySoGraphSearchResult = z.infer<typeof mySoGraphSearchResultSchema>;
export type MySoGraphItemRequest = z.infer<typeof mySoGraphItemRequestSchema>;
export type MySoGraphItemResult = z.infer<typeof mySoGraphItemResultSchema>;
export type MySoGraphNode = z.infer<typeof node>;
export type MySoGraphEdge = z.infer<typeof edge>;
export type MySoGraphEvidence = z.infer<typeof evidence>;
