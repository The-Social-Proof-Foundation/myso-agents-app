import { z } from "zod";
import { authenticatedMySo, MySoAccessError, mySoErrorResponse } from "./myso-auth.ts";

const NO_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const address = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const pageSchema = z.object({
    kind: z.enum(["agents", "organizations"]),
    accountId: address,
    owner: address,
    profileId: address,
    tableCount: z.string().regex(/^(0|[1-9][0-9]*)$/),
    items: z.array(address).max(50),
    hasNextPage: z.boolean(),
    nextCursor: address.nullable(),
    evidenceSource: z.literal("configured_fullnode"),
}).strict();
const ownedObjectsPageSchema = z.object({
    owner: address,
    items: z.array(z.object({
        objectId: address,
        objectType: z.string().min(1).max(512),
        version: z.string().regex(/^[0-9]+$/),
        coinBalanceBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    }).strict()).max(50),
    hasNextPage: z.boolean(),
    nextCursor: address.nullable(),
    evidenceSource: z.literal("configured_fullnode"),
}).strict();
const receiptSchema = z.object({
    digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
    accountId: address,
    status: z.enum(["executed", "finalized", "failed"]),
    stage: z.enum(["proposal", "accepted"]),
    oldOwner: address,
    newOwner: address,
    agentCount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    organizationCount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    updatedAgentCount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    updatedOrganizationCount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    completionProof: z.string().optional(),
    evidenceSource: z.literal("configured_fullnode_scoped_native_event")
        .or(z.literal("configured_fullnode_scoped_native_events_live_registry_counts_and_move_completion_guard")),
}).strict();

export async function handleMySoOwnerRotationManifest(req: Request): Promise<Response> {
    try {
        if (req.method !== "GET") throw new MySoAccessError(405, "Use GET to read owner migration references");
        const auth = await authenticatedMySo(req);
        const query = new URL(req.url).searchParams;
        const kind = z.enum(["agents", "organizations"]).parse(query.get("kind"));
        const limit = z.coerce.number().int().min(1).max(50).parse(query.get("limit") ?? "50");
        const cursor = query.has("cursor") ? address.parse(query.get("cursor")) : undefined;
        const result = await auth.mcp.callTool("agent_admin_owner_rotation_manifest", {
            state: kind,
            limit,
            ...(cursor ? { cursor } : {}),
        }, req.signal);
        if (!result.ok) throw new MySoAccessError(502, "Owner migration references are unavailable from the configured fullnode");
        const page = pageSchema.parse(result.data);
        if (page.kind !== kind || page.items.length > limit || page.hasNextPage !== (page.nextCursor !== null)
            || (page.hasNextPage && (page.items.length === 0 || page.nextCursor === cursor))) {
            throw new MySoAccessError(502, "The owner migration reference page is inconsistent");
        }
        const unique = new Set(page.items.map((item) => item.toLowerCase()));
        if (unique.size !== page.items.length) throw new MySoAccessError(502, "The owner migration reference page contains duplicate objects");
        return Response.json(page, { headers: NO_CACHE });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Owner migration reference query has an unsupported format" }, { status: 400, headers: NO_CACHE });
        return mySoErrorResponse(error);
    }
}

export async function handleMySoOwnerRotationOwnedObjects(req: Request): Promise<Response> {
    try {
        if (req.method !== "GET") throw new MySoAccessError(405, "Use GET to list owner-held objects");
        const auth = await authenticatedMySo(req);
        const query = new URL(req.url).searchParams;
        if ([...query.keys()].some((key) => !["cursor", "limit"].includes(key))) {
            throw new MySoAccessError(400, "Only cursor and limit are accepted");
        }
        const limit = z.coerce.number().int().min(1).max(50).parse(query.get("limit") ?? "50");
        const cursor = query.has("cursor") ? address.parse(query.get("cursor")) : undefined;
        const result = await auth.mcp.callTool("assets_list_owned_objects", {
            limit,
            ...(cursor ? { cursor } : {}),
        }, req.signal);
        if (!result.ok) throw new MySoAccessError(502, "Owner-held objects are unavailable from the configured fullnode");
        const page = ownedObjectsPageSchema.parse(result.data);
        if (page.items.length > limit || page.owner.toLowerCase() !== auth.scope.owner.toLowerCase()
            || page.hasNextPage !== (page.nextCursor !== null)
            || (page.hasNextPage && (!page.items.length || page.nextCursor === cursor))) {
            throw new MySoAccessError(502, "The owner-held object page is inconsistent");
        }
        const unique = new Set(page.items.map((item) => item.objectId.toLowerCase()));
        if (unique.size !== page.items.length) throw new MySoAccessError(502, "The owner-held object page contains duplicate objects");
        return Response.json(page, { headers: NO_CACHE });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Owner-held object query has an unsupported format" }, { status: 400, headers: NO_CACHE });
        return mySoErrorResponse(error);
    }
}

export async function handleMySoOwnerRotationReceipt(req: Request): Promise<Response> {
    try {
        if (req.method !== "GET") throw new MySoAccessError(405, "Use GET to verify an owner migration receipt");
        const auth = await authenticatedMySo(req);
        const query = new URL(req.url).searchParams;
        if ([...query.keys()].some((key) => key !== "id")) throw new MySoAccessError(400, "Only an owner migration transaction digest is accepted");
        const digest = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).parse(query.get("id"));
        const result = await auth.mcp.callTool("agent_admin_owner_rotation_receipt", { id: digest }, req.signal);
        if (!result.ok) throw new MySoAccessError(502, "Owner migration receipt could not be verified from the configured fullnode");
        const receipt = receiptSchema.parse(result.data);
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(receipt.accountId)) throw new MySoAccessError(502, "Owner migration receipt account ID is invalid");
        return Response.json(receipt, { headers: NO_CACHE });
    } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "Owner migration receipt query has an unsupported format" }, { status: 400, headers: NO_CACHE });
        return mySoErrorResponse(error);
    }
}
