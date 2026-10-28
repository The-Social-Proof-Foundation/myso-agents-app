import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const memoryRoot = resolve(appRoot, "../myso-memory");
const platformToolsPath = resolve(memoryRoot, "packages/mcp/src/platform-tools.ts");
const serverReadsPath = resolve(memoryRoot, "services/server/src/platform_reads.rs");
const outputPath = resolve(appRoot, "docs/myso-agents-current-query-coverage.json");

const socialContractPath = resolve(memoryRoot, "packages/mcp/src/social-read-contract.ts");
const [platformTools, serverReads, socialContract] = await Promise.all([
    readFile(platformToolsPath, "utf8"),
    readFile(serverReadsPath, "utf8"),
    readFile(socialContractPath, "utf8"),
]);

const tools = new Map();
function splitArguments(source, openIndex) {
    const result = [];
    let start = openIndex + 1;
    let parens = 1;
    let braces = 0;
    let brackets = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
        if (char === "(") parens += 1;
        else if (char === ")") {
            parens -= 1;
            if (parens === 0) {
                result.push(source.slice(start, index).trim());
                return result;
            }
        } else if (char === "{") braces += 1;
        else if (char === "}") braces -= 1;
        else if (char === "[") brackets += 1;
        else if (char === "]") brackets -= 1;
        else if (char === "," && parens === 1 && braces === 0 && brackets === 0) {
            result.push(source.slice(start, index).trim());
            start = index + 1;
        }
    }
    return result;
}

function stringArray(expression) {
    if (!expression?.startsWith("[")) return [];
    return [...expression.matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] ?? match[2]);
}

function objectKeys(expression) {
    if (!expression?.startsWith("{")) return [];
    const openIndex = expression.indexOf("{");
    const entries = splitArguments(`(${expression.slice(openIndex + 1, expression.lastIndexOf("}"))})`, 0);
    return entries.map((entry) => {
        const match = entry.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/);
        return match?.[1] ?? match?.[2] ?? match?.[3];
    }).filter(Boolean);
}

const addTool = (name, scope, path, details = {}) => {
    if (!name || !scope || !path || !path.startsWith("/api/agent/read/")) return;
    tools.set(name, { name, oauthScope: scope, method: "GET", path, ...details });
};

for (const match of platformTools.matchAll(/read\s*\(/g)) {
    const args = splitArguments(platformTools, match.index + match[0].length - 1);
    if (args.length < 3) continue;
    const name = args[0].match(/^"([^"]+)"$/)?.[1];
    const scope = args[1].match(/^"([^"]+)"$/)?.[1];
    const path = args[2].match(/^"([^"]+)"$/)?.[1];
    if (!name || !scope || !path) continue;
    addTool(name, scope, path, {
        inputParameters: objectKeys(args[4]),
        requiredParameters: stringArray(args[5]),
        pathKeys: stringArray(args[6]),
        queryKeys: stringArray(args[7]),
    });
}
for (const match of platformTools.matchAll(/name:\s*"([^"]+)"\s*,\s*scope:\s*"([^"]+)"\s*,\s*method:\s*"GET"\s*,\s*path:\s*"([^"]+)"/g)) {
    addTool(match[1], match[2], match[3], { inputParameters: [], requiredParameters: [], pathKeys: [], queryKeys: [], schemaInventory: "custom_descriptor_not_parsed" });
}

const serverResources = new Set();
// Count exact match-arm keys, including Rust OR-patterns. A bare `|` also
// occurs in ordinary boolean expressions (`module != "agent_task" || ...`)
// and used to report those module names as missing read routes.
for (const match of serverReads.matchAll(/((?:"(?:config_|badge_|social_|promotion_|agent_|task_|jury_|mydata_|spt_|dex_|poc_|spot_|assets_|payments_|subscription_|organization_|room_|ai_|automation_|chain_)[a-z0-9_]+"(?:\s*\|\s*)?)+)\s*=>/g)) {
    for (const resourceMatch of match[1].matchAll(/"((?:config_|badge_|social_|promotion_|agent_|task_|jury_|mydata_|spt_|dex_|poc_|spot_|assets_|payments_|subscription_|organization_|room_|ai_|automation_|chain_)[a-z0-9_]+)"/g)) {
        if (!resourceMatch[1].endsWith("_")) serverResources.add(resourceMatch[1]);
    }
}
const serverFamilies = new Set(
    [...serverReads.matchAll(/resource\.starts_with\("([a-z0-9_]+)"\)/g)].map((match) => match[1]),
);
for (const match of serverReads.matchAll(/resource\s*==\s*"([a-z0-9_]+)"/g)) {
    serverResources.add(match[1]);
}
const resourceToTools = new Map();
for (const tool of tools.values()) {
    const resource = tool.path.slice("/api/agent/read/".length);
    const current = resourceToTools.get(resource) ?? [];
    current.push(tool.name);
    resourceToTools.set(resource, current);
}

const serverUnmapped = [...serverResources].filter((resource) => !resourceToTools.has(resource)).sort();
const mcpUnmapped = [...resourceToTools.keys()].filter((resource) =>
    /^(?:config_|badge_|social_|promotion_|agent_|task_|jury_|mydata_|spt_|dex_|poc_|spot_|assets_|payments_|subscription_|organization_|room_|ai_|automation_|chain_)/.test(resource)
    && !serverResources.has(resource)
    && ![...serverFamilies].some((prefix) => resource.startsWith(prefix)),
).sort();
const scopes = Object.fromEntries([...tools.values()].reduce((counts, tool) => {
    counts.set(tool.oauthScope, (counts.get(tool.oauthScope) ?? 0) + 1);
    return counts;
}, new Map()));
const readQueryBody = serverReads.match(/pub struct ReadQuery\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const serverQueryFields = new Set();
for (const field of readQueryBody.matchAll(/(?:#\[serde\(rename\s*=\s*"([^"]+)"(?:\s*,\s*alias\s*=\s*"([^"]+)")?\)\]\s*)?pub\s+([a-z_][a-z0-9_]*)\s*:/g)) {
    serverQueryFields.add(field[1] ?? field[2]);
    if (field[2]) serverQueryFields.add(field[2]);
    serverQueryFields.add(field[3]);
}
for (const tool of tools.values()) {
    tool.unknownServerQueryKeys = (tool.queryKeys ?? []).filter((key) => !serverQueryFields.has(key));
}
const toolsWithUnknownQueryKeys = [...tools.values()].filter((tool) => tool.unknownServerQueryKeys.length > 0);
const socialContractNames = new Set([...socialContract.matchAll(/^  "(social_[^"]+)": \{$/gm)].map((match) => match[1]));
const socialTools = [...tools.values()].filter((tool) => tool.name.startsWith("social_"));
const socialToolsMissingScope = socialTools.filter((tool) => tool.oauthScope !== "social:read").map((tool) => tool.name);
const socialToolsMissingContract = socialTools.filter((tool) => !socialContractNames.has(tool.name)).map((tool) => tool.name);
const hostedResponseValidationFamilies = {
    social: socialTools.map((tool) => tool.name),
    config: ["config_profile", "config_platform", "config_memory", "config_ai_credit"],
    badge: ["badge_list", "badge_get"],
    promotions: [...tools.values()].filter((tool) => tool.name.startsWith("promotion_")).map((tool) => tool.name),
    organization: ["organization_list_messaging_groups", "organization_list_roles", "organization_list_role_assignments", "organization_list_invitations", "organization_list_memory_permissions", "organization_list_spend_approvals", "organization_list_spend_breakdown", "organization_list_audit_logs"],
    aiCredit: ["ai_get_balance", "ai_list_approvals", "ai_list_usage", "ai_list_reservations", "ai_get_reservation"],
    myData: ["mydata_list_graph_offers", "mydata_list_agent_funding_coins", "mydata_get_purchase_quote", "mydata_get_purchase_receipt", "mydata_get_owner_access_receipt", "mydata_list_owner_access_history", "mydata_list_listings", "mydata_list_owned_listings", "mydata_check_indexed_access", "mydata_get_indexed_listing", "mydata_get_indexed_stats", "mydata_get_indexed_configuration", "mydata_get_indexed_revenue_timeline", "mydata_get_indexed_access_analytics", "mydata_get_snapshot_anchor", "mydata_get_snapshot_distribution", "mydata_get_snapshot_merkle_root", "mydata_get_snapshot_escrow", "mydata_list_snapshot_claims", "mydata_read_indexed_catalog", "mydata_list_popular_indexed", "mydata_list_creator_listings", "mydata_list_broad_pools", "mydata_list_broad_pool_sub_pools", "mydata_list_listing_sub_pools", "mydata_list_sub_pool_listings", "mydata_list_distribution_rounds", "mydata_list_indexed_access_logs", "mydata_list_indexed_purchases", "mydata_list_indexed_revenue", "mydata_list_indexed_subscriptions", "mydata_list_my_purchases"],
    payments: ["payments_get_balance", "payments_list_coins", "payments_get_transfer_quote", "payments_get_transfer_receipt"],
    subscriptions: ["subscription_get_plan_quote", "subscription_get_renewal_quote", "subscription_get", "subscription_list", "subscription_list_plans", "subscription_get_receipt"],
    agentAdmin: ["agent_admin_list", "agent_admin_get_quote", "agent_admin_get_receipt", "agent_admin_owner_rotation_manifest", "agent_admin_owner_rotation_status", "agent_admin_owner_rotation_progress", "agent_admin_owner_rotation_receipt"],
    agent: ["agent_get_reputation", "agent_list_children", "agent_list_profile_agents", "agent_list_receipts", "agent_get_own_pnl", "agent_list_owned_pnl"],
    accountAudit: ["account_list_audit_logs"],
    accountUsage: ["account_get_memory_usage"],
    poc: ["poc_get_analytics", "poc_get_badge", "poc_get_beneficiary_transfer_receipt", "poc_get_beneficiary_vault", "poc_get_claim_receipt", "poc_get_configuration", "poc_get_dispute", "poc_get_username_beneficiary", "poc_get_username_beneficiary_by_username", "poc_get_vault_for_beneficiary", "poc_list_analysis_results", "poc_list_badges", "poc_list_dispute_votes", "poc_list_disputes", "poc_list_revenue_redirections", "poc_list_username_beneficiaries", "poc_list_vault_claims", "poc_list_vault_coin_balances", "poc_list_vault_deposits"],
    dex: ["dex_list_markets", "dex_get_market", "dex_get_orderbook", "dex_get_summary", "dex_get_ticker", "dex_list_trades", "dex_get_indexer_status", "dex_get_swap_receipt"],
    governance: ["governance_get_vote_quote", "governance_get_vote_receipt", "governance_get_delegate_vote_receipt"],
    action: ["chain_list_action_approvals", "chain_get_action_receipt", "chain_find_action_by_idempotency_key"],
    messaging: ["messaging_get_room_details", "messaging_list_room_members", "messaging_list_room_digests", "messaging_get_message_receipt", "messaging_get_group_creation_receipt", "messaging_get_membership_change_receipt", "messaging_list_my_wallet_history", "messaging_list_my_paid_message_history", "messaging_get_my_revenue_summary", "messaging_get_task_room_binding_receipt", "room_list"],
    tasks: ["task_get_receipt", "task_get_settlement_receipt", "task_list", "task_list_for_agent", "task_list_for_organization", "task_market_list", "task_market_list_sellers", "task_market_get_stats", "task_market_get_seller_reputation", "task_get_room", "task_list_history", "task_get_lifecycle_history", "task_get", "task_get_deliverable", "task_get_dispute", "task_list_agent_funding_coins", "task_get_config"],
    jury: ["jury_get_action_receipt", "jury_list_assignments", "jury_list_roster", "jury_health", "jury_list_cases", "jury_get_case", "jury_get_case_bundle", "jury_get_own_profile", "jury_list_case_rationales", "jury_list_cranks", "jury_get_task_dispute", "jury_get_proposal_case", "jury_get_proposal_vote_refunds"],
    assets: ["assets_get_transfer_receipt", "assets_get_burn_receipt", "assets_get_owned_object", "assets_list_owned_objects"],
    organizationTreasury: ["organization_get_treasury_balance", "organization_get_treasury_access"],
    organizationPublic: ["organization_get", "organization_get_statistics", "organization_list_categories", "organization_list_leaderboard", "organization_list_my_invitations", "organization_list_owned", "organization_list_rooms"],
    spot: ["spot_get_claim_receipt", "spot_get_bet_receipt", "spot_get_market_receipt"],
    spt: ["spt_get_configuration", "spt_get_pool", "spt_get_pool_by_associated_id", "spt_get_reservation_pool", "spt_get_user_holdings", "spt_list_pool_holdings", "spt_list_pool_price_history", "spt_list_pool_revenue", "spt_list_pool_swaps", "spt_list_pool_transactions", "spt_list_pool_transfers", "spt_list_pools", "spt_list_popular_pools", "spt_list_reservation_pools", "spt_list_reservations", "spt_get_reservation_volume_history", "spt_list_user_reservations", "spt_get_market_sentiment", "spt_get_pool_liquidity_profile", "spt_get_portfolio_performance", "spt_get_position_metrics", "spt_get_position_timeseries", "spt_get_top_performers", "spt_list_creator_revenue_streams", "spt_list_trader_leaderboard", "spt_get_trade_quote", "spt_get_trade_receipt"],
};
const hostedResponseValidatedTools = new Set(Object.values(hostedResponseValidationFamilies).flat());
const hostedResponseValidationMissingTools = [...tools.keys()].filter((name) => !hostedResponseValidatedTools.has(name)).sort();
const hostedResponseValidationOccurrences = Object.values(hostedResponseValidationFamilies).flat().filter((name) => tools.has(name));
const hostedResponseValidationMemberships = new Map();
for (const name of hostedResponseValidationOccurrences) hostedResponseValidationMemberships.set(name, (hostedResponseValidationMemberships.get(name) ?? 0) + 1);
const hostedResponseValidationOverlaps = [...hostedResponseValidationMemberships].filter(([, count]) => count > 1).map(([name]) => name).sort();
const socialCallerAddressIsPrincipal = /"(social_(?:profile|post|platform|subscription|revenue|search|username)_[a-z0-9_]*)"[\s\S]{0,700}input\.address[\s\S]{0,300}auth\.owner/.test(serverReads);
const toolsWithUnmappedInputParameters = [...tools.values()].flatMap((tool) => {
    const routed = new Set([...(tool.pathKeys ?? []), ...(tool.queryKeys ?? [])]);
    const unmapped = (tool.inputParameters ?? []).filter((key) => !routed.has(key));
    const undeclared = [...routed].filter((key) => !(tool.inputParameters ?? []).includes(key));
    return unmapped.length || undeclared.length ? [{ name: tool.name, inputKeysWithoutRoute: unmapped, routeKeysWithoutInput: undeclared }] : [];
});

const manifest = {
    schemaVersion: "myso.agents.mcp-query-coverage.v1",
    refreshedAt: new Date().toISOString().slice(0, 10),
    evidenceLevel: "static_source_inventory",
    inventoryScope: "PLATFORM_TOOLS entries in platform-tools.ts that expose /api/agent/read/* routes. Other custom MCP tools and non-platform route families are outside this generated inventory.",
    source: {
        mcpToolRegistry: "../myso-memory/packages/mcp/src/platform-tools.ts",
        memoryReadDispatcher: "../myso-memory/services/server/src/platform_reads.rs",
    },
    summary: {
        platformToolReadRoutes: tools.size,
        platformToolsByOAuthScope: scopes,
        exactServerReadResourcesWithoutPlatformTool: serverUnmapped,
        platformToolResourcesWithoutExactOrFamilyDispatch: mcpUnmapped,
        platformReadFacadeRouteNameCoverageComplete: serverUnmapped.length === 0 && mcpUnmapped.length === 0,
        serverFamilyDispatchPrefixes: [...serverFamilies].sort(),
        queryKeysNotDeclaredByReadQuery: toolsWithUnknownQueryKeys.map(({ name, unknownServerQueryKeys }) => ({ name, keys: unknownServerQueryKeys })),
        inputSchemaKeysNotMappedToRoute: toolsWithUnmappedInputParameters,
        routeKeysMissingFromInputSchemas: toolsWithUnmappedInputParameters,
        queryKeyDeclarationAuditComplete: toolsWithUnknownQueryKeys.length === 0,
        inputSchemaToRouteKeyParityComplete: toolsWithUnmappedInputParameters.length === 0,
        parameterAndResponseFieldParity: socialToolsMissingContract.length === 0 && socialToolsMissingScope.length === 0
            ? "social_family_response_and_scope_checked; ai_credit_all_read_contracts_owner_identity_and_i64_bounds_checked; payment_coin_balance_owner_coins_exact_transfer_quote_historical_effect_receipt_source_checked; subscription_owner_scope_quote_receipt_and_filtered_cursor_pagination_checked; task_lists_participant_scope_deduplication_and_stable_order_checked; task_market_seller_ranking_filters_sort_and_identity_checked; task_history_participant_scope_deduplication_and_source_order_checked; mydata_graph_offer_pages_exact_fields_i64_bounds_unique_ids_and_source_order_checked; mydata_owned_listing_owner_scope_paid_graph_inclusion_and_source_order_checked; mydata_history_owner_scope_identity_and_timestamp_id_order_checked; messaging_exact_dtos_owner_binding_live_membership_evidence_and_capability_checks_checked; poc_public_lists_exact_fields_identity_and_deterministic_page_order_checked; config_badge_exact_fields_i64_bounds_latest_revocation_semantics_and_stable_paging_checked; promotion_filters_exact_fields_i64_bounds_and_stable_order_checked; asset_reads_owner_scope_exact_u64_page_cursors_and_canonical_scoped_effect_receipts_checked; agent_admin_owner_scope_unique_targets_quote_authority_and_receipt_account_binding_checked; dex_swap_receipt_scoped_status_and_fill_total_consistency_checked; organization_owned_owner_scope_unique_ids_and_stable_paging_checked; organization_leaderboard_exact_fields_rank_category_metric_and_stable_tiebreak_order_checked; other_families_still_need_field_and_authorization_checks"
            : "social_family_incomplete; other_families_still_need_field_and_authorization_checks",
        socialReadFamily: {
            toolCount: socialTools.length,
            responseContractCount: socialContractNames.size,
            toolsMissingSocialReadScope: socialToolsMissingScope,
            toolsMissingResponseContract: socialToolsMissingContract,
            callerSuppliedAddressUsedAsPrincipal: socialCallerAddressIsPrincipal,
            complete: socialTools.length > 0 && socialToolsMissingScope.length === 0 && socialToolsMissingContract.length === 0 && socialContractNames.size >= socialTools.length && !socialCallerAddressIsPrincipal,
        },
        hostedResponseValidation: {
            countsByFamily: Object.fromEntries(Object.entries(hostedResponseValidationFamilies).map(([family, names]) => [family, names.filter((name) => tools.has(name)).length])),
            validatedToolCount: [...hostedResponseValidatedTools].filter((name) => tools.has(name)).length,
            familyMembershipOccurrences: hostedResponseValidationOccurrences.length,
            toolsInMultipleFamilies: hostedResponseValidationOverlaps,
            toolsMissingResponseValidationCount: hostedResponseValidationMissingTools.length,
            complete: hostedResponseValidationMissingTools.length === 0 && hostedResponseValidationOverlaps.length === 0,
        },
        organizationRoleProofCoverage: "source_audited_all_14: ten sensitive reads require dashboard_viewer/auditor grants or live owner/admin checks; three category/org-profile/leaderboard reads are public; one owned-organization read is bound to the authenticated owner; deployment/runtime is not audited",
        deploymentReadiness: "not_audited",
    },
    authorityNotes: {
        identity: "Inputs and scopes are inventoried from the MCP registry; actual principal binding and per-resource role checks must be verified in the gateway and server handler.",
        readDependencies: "The server dispatcher and downstream fullnode, indexer, social-server, messaging, automation, and AI-credit dependencies are not inferred as authoritative from route names.",
        builders: "GET query tools do not construct transactions. Mutating actions and their builders are tracked in myso-agents-current-action-coverage.json.",
        effectVerification: "Receipt-named reads require action-specific fullnode verification; ordinary list/detail reads are snapshots and do not prove finalized effects or live authority.",
        deploymentGate: "Feature flags, package IDs, service credentials, network compatibility, and hosted adapters remain per-tool gates and require a separate config audit.",
    },
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${tools.size} MCP read-route records to ${outputPath}`);
