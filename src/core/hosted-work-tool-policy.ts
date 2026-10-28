/**
 * Tools excluded from hosted work runs for privacy or side-effect control.
 * Keep this shared by the UI, admission endpoint and coordinator so a caller
 * cannot bypass a client-side omission by editing the request body.
 */
const HOSTED_WORK_FORBIDDEN_TOOLS = new Set([
    "mydata_read_content",
    "messaging_download_room_attachment",
    "messaging_edit_message",
    "messaging_delete_message",
    "messaging_remove_members_rotate_key",
    "messaging_revoke_member_from_all_rooms",
    "messaging_set_room_name",
    "messaging_archive_group",
    "messaging_leave_group",
    "messaging_update_read_state",
]);

export const HOSTED_WORK_ROOM_HISTORY_TOOL = "messaging_get_room_history";
export const HOSTED_WORK_ROOM_ATTACHMENT_TOOL = "messaging_get_room_attachment";
export const HOSTED_WORK_ROOM_CONTENT_TOOLS = new Set([HOSTED_WORK_ROOM_HISTORY_TOOL, HOSTED_WORK_ROOM_ATTACHMENT_TOOL]);
export const HOSTED_WORK_PRIVATE_GRAPH_TOOLS = new Set(["mydata_search_graph", "mydata_get_graph_item"]);
/** Reads that can return private bytes or plaintext into a hosted model turn. */
export const HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS = new Set(["task_get_deliverable"]);
export const HOSTED_WORK_PRIVATE_CONTEXT_TOOLS = new Set([
    HOSTED_WORK_ROOM_HISTORY_TOOL,
    HOSTED_WORK_ROOM_ATTACHMENT_TOOL,
    ...HOSTED_WORK_PRIVATE_GRAPH_TOOLS,
    ...HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS,
]);
export const HOSTED_WORK_PRIVATE_CONTENT_OUTPUT_TOOLS = new Set([
    "messaging_send_message",
    "messaging_add_room_members",
    "messaging_upload_room_attachment",
    "social_create_post",
    "social_create_comment",
    "social_create_repost",
    "task_deliver",
    "task_upload_deliverable",
    "mydata_publish_graph",
    "access_share_mydata",
]);

/** Unknown or newly added MCP tools are treated as possible destinations unless explicitly read-only. */
export function requiresHostedPrivateContentSharingConsent(name: string, readOnly: boolean): boolean {
    return HOSTED_WORK_PRIVATE_CONTENT_OUTPUT_TOOLS.has(name) || !readOnly;
}

export function isHostedWorkToolForbidden(name: string): boolean {
    return HOSTED_WORK_FORBIDDEN_TOOLS.has(name);
}
