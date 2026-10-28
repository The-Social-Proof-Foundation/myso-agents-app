import { z } from "zod";

const order = z.union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
]).transform((value) => String(value));
const cursorSchema = z.union([
    z.object({ afterOrder: order, beforeOrder: order.optional() }).strict(),
    z.object({ beforeOrder: order }).strict(),
]);

export const roomHistoryPageSchema = z.object({
    groupId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    entries: z.array(z.discriminatedUnion("status", [
        z.object({ messageId: z.string().min(1).max(128), order, status: z.literal("verified_content"), content: z.object({ text: z.string().max(1_048_576), kind: z.string().optional(), senderAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }).strict() }).strict(),
        z.object({ messageId: z.string().min(1).max(128), order, status: z.enum(["unverified_content", "unavailable_content", "system_metadata", "deleted_metadata"]) }).strict(),
    ])).max(50),
    hasNext: z.boolean(),
    nextCursor: cursorSchema.nullable(),
    allContentVerified: z.boolean(),
    metadataSource: z.literal("relayer_unverified"),
}).strict();
export type RoomHistoryPage = z.infer<typeof roomHistoryPageSchema>;

export const roomReceiptsSchema = z.object({
    members: z.array(z.object({
        member: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
        deliveredUpto: order,
        readUpto: order,
    }).strict()).max(500),
}).strict().superRefine((receipts, ctx) => {
    if (new Set(receipts.members.map(({ member }) => member.toLowerCase())).size !== receipts.members.length) {
        ctx.addIssue({ code: "custom", path: ["members"], message: "duplicate room receipt member" });
    }
});
export type RoomReceipts = z.infer<typeof roomReceiptsSchema>;

export const roomReceiptUpdateResultSchema = z.object({
    updated: z.literal(true),
    metadataSource: z.literal("relayer_unverified"),
}).strict();
export type RoomReceiptUpdateResult = z.infer<typeof roomReceiptUpdateResultSchema>;

export const roomReceiptUpdateRequestSchema = z.object({ readUpto: order }).strict();

export const roomMemberPageSchema = z.object({
    groupId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    members: z.array(z.object({
        address: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
        permissions: z.array(z.string().min(1).max(512)).max(32),
    }).strict()).max(100),
    limit: z.number().int().min(1).max(100),
    hasNextPage: z.boolean(),
    nextCursor: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).nullable(),
    membershipEvidence: z.literal("configured_fullnode_current_messaging_reader"),
    source: z.literal("configured_fullnode_permission_table"),
}).strict().superRefine((page, ctx) => {
    if (page.hasNextPage !== (page.nextCursor !== null)) ctx.addIssue({ code: "custom", path: ["nextCursor"], message: "member cursor does not match page state" });
    if (new Set(page.members.map((member) => member.address.toLowerCase())).size !== page.members.length) ctx.addIssue({ code: "custom", path: ["members"], message: "duplicate room member" });
});
export type RoomMemberPage = z.infer<typeof roomMemberPageSchema>;

const roomAttachmentBase = z.object({
    groupId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    storageId: z.string().regex(/^r2room:\/\/(0x)?[0-9a-fA-F]{1,64}\/[0-9a-fA-F-]{36}$/),
    contentLength: z.number().int().min(1).max(5 * 1024 * 1024),
    sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
    storage: z.literal("cloudflare_r2"),
    ciphertextOnly: z.literal(true),
    idempotentReplay: z.boolean(),
}).strict();

export const roomAttachmentUploadSchema = roomAttachmentBase;
export type RoomAttachmentUpload = z.infer<typeof roomAttachmentUploadSchema>;

export const roomAttachmentDownloadSchema = roomAttachmentBase.extend({
    contentBase64: z.string().min(4).max(6990508).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export type RoomAttachmentDownload = z.infer<typeof roomAttachmentDownloadSchema>;

export const roomHistoryRequestSchema = z.object({
    uuid: z.string().uuid(),
    afterOrder: order.optional(),
    beforeOrder: order.optional(),
    limit: z.number().int().min(1).max(50).default(20),
}).strict();
