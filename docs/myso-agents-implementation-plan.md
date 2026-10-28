# MySo Agents implementation plan

Status: **approved by the owner; implementation in progress**. Owner response: “Approve the plan and begin implementation.” October 24, 2026. The full completion checklist remains open. See [implementation status](myso-agents-implementation-status.md) for source changes and compile evidence.

## 1. Requested outcome and working rules

Transform `/Users/brandonshaw/Offline-Projects/ProjectYZ/myso-agents-app` from LearnHarness into **MySo Agents**: a task marketplace and agent coordination application backed by MySo identity, organizations, messaging rooms, automation, AI credits, encrypted private knowledge graphs and knowledge purchases. Fill the remaining MCP action and read/list coverage across the platform, including catalog operations whose implementation is currently missing.

The goal includes all platform coverage, not only a pilot task flow. Milestones below sequence delivery without narrowing that goal. A tool that only returns “unsupported” does not complete an action. An action may remain intentionally restricted to its authorized operator role, but that restriction must be explicit and supported by an actual permitted execution path.

Owner constraints:

- Do not start applications, services, background workers, containers, networks or simulations.
- Do not run tests or smoke/integration scripts. The owner will run tests and runtimes.
- Compilation/type checking is permitted; inspect command scripts first because some “build” commands launch smoke servers or execute other scripts.
- Do not commit, push, publish, deploy, submit transactions, provision wallets or modify running services.
- Preserve existing changes in every repository. Do not initialize Git in the app merely because its `.git` directory is absent.
- Approve the plan before product implementation, as explicitly required by the app's `AGENTS.md`. Resolve remaining product choices with the owner.

## 2. Current source baseline and corrections

| Component | Verified local location | State observed |
|---|---|---|
| New app | `ProjectYZ/myso-agents-app` | MySo Agents source is in place; `.git`, `node_modules` and `.next` exist. HEAD `c8742a7`; substantial existing modified/untracked implementation changes are present and must be preserved. Do not read or copy local secret values. |
| Messaging | `ProjectYZ/myso-messaging-stack` | HEAD `bdb008e`; existing modified and untracked SDK/chat changes are present. |
| Memory/MCP/automation | `ProjectYZ/myso-memory` | HEAD `492d353`; existing modified and untracked MCP, SDK, server, R2, automation, and action-registry changes are present. |
| Core/contracts/indexers/oracle | `ProjectYZ/myso-core` | HEAD `1c39abf`; existing modified and untracked Move, messaging, social reader/indexer, subscription, automation-adjacent and AI-credit-oracle changes are present. |

There are no separate folders named `myso-agent-automations`, `myso-ai-credit`, or `myso-message-stack` in the project root. Use `myso-memory/services/automation` and `services/automation-sidecar`, `myso-core/crates/myso-ai-credit-oracle`, and `myso-messaging-stack`. The owner confirmed these existing implementations are the intended sources. The request references `assessment.md`, but no such file was found in the app or these repositories; the approved plan and current status/coverage documents contain the recorded assessment decisions. If another assessment file exists elsewhere, its path is the only unresolved source reference.

Earlier assessments are background evidence. This plan supersedes their following incomplete conclusions:

- Reuse the existing Postgres automation service, retry/policy/idempotency code and encrypted delegate bridge. Do not implement a second authoritative scheduler inside the app.
- The AI-credit oracle already accepts structured messages and tools, exposes OpenAI-compatible chat/responses endpoints and has a reservation reconciliation worker. Its compatible endpoints explicitly reject streaming. The memory SDK/relayer's public gateway method is narrower. Extend the authenticated public path and adapter rather than build structured inference from zero.
- The existing compatible-provider identity is configured from service arguments and its request builder generates fresh UUID idempotency keys. A shared hosted multi-account product needs per-request authenticated identity and persisted call keys; it cannot just share that one provider token across tenants.
- The messaging SDK already supports encryption, message history, subscriptions, reactions, read state, receipts, attachments, group creation and key rotation. Its chat app already implements agent chats, room verification, task/jury views, automation clients and delegate encryption. Extract reusable shared clients without importing Vite UI/runtime configuration into Next.js.
- MyData contracts already implement one-time and recurring marketplace listings, purchase, access-policy checks, grants/revocations and indexer readers. A graph-specific format, content rights and safe access lifecycle still need design and implementation.

No runtime readiness, deployed address, funded account or key-server availability is assumed from source alone.

### Source coverage inventory completed

`myso-agents-source-coverage.md` and its JSON companion now record the planning baseline with source paths, line references and SHA-256 fingerprints:

- 110 production catalog actions: 73 marked enabled and 37 requiring builder/adapter implementation.
- 32 catalog actions have dedicated tools advertised by the current MCP gateway; 41 enabled actions do not.
- Two additional executable-registry actions (`social.delete_post.v1`, `social.delete_comment.v1`) sit outside that production catalog and are not advertised by the gateway. Reconcile catalog, approval policy and callable exposure explicitly.
- 319 raw route declarations across the inspected social/memory/automation roots (309 outside `/internal/`) and 36 public async messaging SDK methods are indexed as reuse candidates. These counts do not imply authorization, query completeness or deployed readiness.

This is read-only source evidence, not implementation or runtime validation. No product source changed while producing it. The owner subsequently approved implementation; this inventory remains the historical baseline.

## 3. Confirmed product decisions and remaining review

D1 — Confirmed: support both hosted web and the existing desktop app.

D2 — Confirmed: public graph discovery is in scope and metadata-only previews remain explicitly unverified; they cannot imply manifest validity, seller rights, quality, or purchase suitability. The source purchase flow uses the verified versioned manifest, seller rights claims, explicit offer terms, and buyer-selected audience; each execution still rechecks the live quote, MyData deployment policy and on-chain authority. Purchases use **direct peer-to-peer MyData access**, one-time or subscription for that pinned version. Discovery is redacted and entitlement-aware; it never bypasses offer terms, explicit organization audience selection or access checks. Revocation stops future key releases and invalidates protected server caches, but cannot retract content already decrypted/exported.

D3 — Confirmed: agents may purchase and settle automatically only under live on-chain capabilities, approval policy and per-action spend limits. Escalate only when current chain authority requires owner approval. Do not introduce app-side, work-run or step-level spend caps, and do not require a per-payment signature for actions already authorized on chain.

D4 — Confirmed: use automation in `myso-memory/services/automation` plus its sidecar, AI credits in `myso-core/crates/myso-ai-credit-oracle`, and `myso-messaging-stack`.

Product naming, within the variants the owner already supplied: visible product **MySo Agents**, package/slug **myso-agents**, code identifier **MySoAgents**. Confirmed desktop identity: `com.mysocial.agents`; product/help URL: `https://mysocial.network/agents`. The update-feed URL and GitHub release repository supplied by the owner are placeholders only; updates must stay disabled until real feed and signing infrastructure exist. macOS development builds remain unsigned/ad-hoc; Windows publisher identity is “MySocial” with its certificate still TBD. Never retain upstream release/signing targets.

Offer terms must explicitly identify the seller, graph/version, one-time versus subscription price, duration and supported revocation policy. Use existing MyData economics rather than inventing fees or resale licenses. There is no assumed permission to sell private source material or organization knowledge.

The owner approved this plan and implementation. D5, subsequently confirmed: match the existing MySocial app’s brand and interface; use its existing tokens and assets. Do not request plan approval again.

D6 — Confirmed: choose the organization audience separately for each private graph purchase. The authenticated buyer's selected organization is pinned to that purchase; do not infer or broaden the audience from the buyer's other memberships.

D7 — Confirmed: tipping is for posts only. Do not add or expose profile, comment, or repost tipping. Keep `payments.tip_profile.v1` excluded/deferred in catalog accounting; the only tip execution path is `payments.tip_post.v1`.

D8 — Confirmed: each paid graph purchase is an immutable snapshot. Once a bounded purchase exists, freeze the listing ciphertext and encryption identity; publish later graph versions as distinct MyData objects and retain the purchased object's digest.

D9 — Confirmed: DEX pair/market is chosen from the configured Orderbook REST catalog at use time. `dex_list_markets` reads `/get_pools`; bounded preflight reads can use `/orderbook/:pool_name`, `/summary`, `/ticker`, `/trades/:pool_name` and optional `/status`. `dex.swap.v1` is adapter-only and must build/sign existing MySo Orderbook v3 Move PTBs; no contract/Move changes, margin packages, bridge, or unrelated DEXs. Do not advertise swap until a fixed builder, network configuration, identity/authority binding, exact amount/price constraints and scoped receipt path all exist. A catalog entry or book snapshot is not a fill guarantee.

D10 — Chosen for network continuity: an agent explicitly invited into a room may read its existing history as well as future messages. Joining is the room owner/admin's consent boundary and the invite UI/API must state this plainly before the membership change. This matches the current MyData permission model and lets agents recover task context. Never add a reader silently or infer room access from organization/task membership alone.

D11 — Confirmed October 27, 2026: private purchased-graph plaintext may enter both interactive and unattended hosted model runs when the owner explicitly consents. Interactive consent is attached to the current run turn; unattended consent is an explicit standing setting on the automation and is copied into each fresh, short-lived run-worker credential. Every graph page still requires the worker's live MyData capability/session and the exact purchased version and selected audience. Graph text is stripped from durable harness checkpoints, and sending it to other MCP destinations still requires separate private-content sharing consent. Provider retention and already-derived/exported data remain separate policy risks; do not claim revocation can recall content already released.

D12 — Confirmed October 28, 2026: task and graph artifacts use Cloudflare R2 for now. Do not add WAL/File Storage dependencies; that service is not available for this MVP.

D13 — Confirmed subscription payout change semantics: changing a creator's payout recipient routes future subscription payments and renewals to the new recipient. Already collected or prefunded funds remain at their existing destination.

Q1/Q3 — Confirmed graph contract: `GraphManifest` carries entities, relations, evidence references, coverage keys and encryption-envelope references. A version is its immutable manifest hash plus seller-signed publication record; each listing and purchase pins exactly one version, with historic records keyed by `(graph_id, version_hash)`. Subscriptions do not silently advance to future versions; each later publication requires a separately verified offer and purchase. The seller signs the `source_rights` claims for every entity and evidence source; separate source-owner grant records are not required. The seller's current org-admin or `sell_graph` delegate authority is checked live at listing/verification time. Preview is metadata-only. The purchase lifecycle is purchase → entitlement → key release → cache; revoke prevents new keys and invalidates protected server caches, without promising recall of decrypted copies.

Q4/Q5 — Confirmed graph offer terms and audience: the seller chooses one of three terms templates (perpetual one-time, subscription revoked at period end, or subscription with seller early revocation limited to future access). Buyer acknowledges the selected terms before paying. The buyer explicitly chooses either the connected agent or one eligible organization for each purchase, with no default; persist the selected audience immutably with the purchase. The organization is the access audience, while the authenticated agent can fund an automatic purchase with its own coin when live on-chain action permissions authorize it.

Q6/Q8/Q9 — Confirmed execution policy: the owner has explicitly authorized agent-funded graph purchases without repeated approval when live on-chain capability/approval policy and the per-action spend limit authorize the exact quoted price. Do not add seller allowlists or app-side spending limits. The agent's own MYSO coin funds the purchase for either the agent or organization audience. Core has no organization spendable MYSO cap today; `OrgBudgetManager` applies to AI credits only. Purchases requiring owner approval use the exact owner-wallet approval path. Successful purchases create receipts in Activity. Recompute capability manifests at phase gates. A tool is advertised only when its handler, builder and deployment config are ready; execution rechecks OAuth scope, live capability/approval policy, exact coin ownership, on-chain per-action limit, audience and current offer. Include per-tool compatibility metadata. High-authority controls require deployment flag, OAuth scope, operator role and any configured two-step approval. Implement reads/lists before writes.

Q10 — Confirmed public knowledge discovery: indexed read/search/list is in scope, with redaction and entitlement-aware previews. Metadata-only graph previews remain labeled unverified and separate from global task matching. Source purchase flow may proceed only after seller proof, manifest hash, source-rights claims, exact live quote, explicit terms and buyer-selected audience are verified; chain execution remains gated by deployed MyData policy and current on-chain authority.

Q12/Q13 — Confirmed shared MySocial tokens/assets, with a MySo Agents icon and no Next/Electron dependency on iOS asset catalogs. Approved information architecture: Home (chat field, overview stats, activity); Marketplace (Tasks and Rooms); Knowledge; Agents (Organizations, Automations, Activity); Settings.

Q14/Q15 — Confirmed greenfield naming: no LearnHarness compatibility layer in the shippable app; replace active `LH_*` and `lh:*` names. Keep app data and keys separate. Optional legacy import is explicit and off by default; imported LearnHarness material is read-only in Knowledge and never auto-converted into paid tasks.

Q16–Q26 — Confirmed operational semantics: the database inbox is authoritative and enqueue is transactional; the bus only wakes workers; delivery is at-least-once with idempotent consumers. Automation v1 implements debounce, window caps, multi-event ALL and replay, with unsupported settings rejected only when actually unimplemented. Persist each automation's IANA timezone, store UTC schedule slots and use one canonical slot for evaluation/idempotency. Long tasks use async accept/progress/artifact/verify/complete workers with documented max step and heartbeat; webhooks handle fast side effects only. No AI streaming in v1. Bind AI reserve/capture to authenticated agent/account/org and persist operation keys before provider calls. Enforce classifications `public`, `org_confidential`, `encrypted_graph`, `redacted_summary_only`; private graph content may reach hosted inference only with the relevant explicit interactive-run consent or standing unattended-automation consent, a scoped worker credential, live MyData access, immutable purchased snapshot, and separate destination-sharing consent. Room history may be included only with explicit per-run consent. Task-room is 1:1 by default, with optional linked rooms; dedupe self-generated status by event type + cursor. Messages carry control/progress; content-addressed artifacts carry hash and signature verification separate from message sequence checks; receipts bind artifact hash and chain digest. Task matching is org-scoped first and cannot accept a stale offer version. Use workspace packages with semver; sibling links are for development only, never absolute shipping paths.

Q27/Q28 — Confirmed build/deployment boundaries: Move is compile-only and owner applies migrations. Nothing may be assumed deployed until the owner supplies RPC/orderbook URL, addresses, keys and funded accounts.

Q31 — Confirmed unattended-run identity: use the existing `action_worker` delegate to decrypt MyData-encrypted work runs. Issue a short-lived, revocable credential bound to one owner/account/agent/run and the selected delegate; keep the delegate seed inside the trusted automation sidecar, enforce its explicit action allowlist plus live on-chain capabilities and per-action MYSO cap at every worker boundary, and never persist the owner's OAuth bearer. No parent-agent session fallback is allowed.

Q32 — Confirmed room archive authorization: a delegated agent may archive only with live `PermissionsAdmin` for that exact room and a fresh owner-wallet signature after an explicit irreversible-action confirmation. Hosted workers cannot archive rooms.

Q33 — Earlier answer selected a separate owner-set per-run transaction-gas ceiling. **Superseded by the owner's October 28, 2026 clarification:** spending limits and permissions must come from on-chain authority; do not add a work-run or step-level spend cap. Transaction gas remains a transaction-construction parameter and actual net charges are recorded from finalized receipts.

Q29/Q30 — Confirmed review semantics: §7 milestones are checkpoints; R1–R14 define completion. Re-estimate from the current manifest after P0 and P4, rather than reusing historical blocked-action counts.

## 4. Target ownership and data flow

| Owner | Responsibilities |
|---|---|
| MySo Agents app | Task planning, run/room/graph/market UI, explainable work history, operator review and approval presentation |
| myso-memory/MCP | Authenticated shared API, scopes, tool catalog and execution, private memory and graph services, signed structured inference gateway, artifacts |
| Existing automation service | Durable triggers, run/step scheduling, worker leases, retries, task action dispatch, event inbox/outbox and recovery |
| Messaging stack | Encrypted group/message transport, member policy, room identity, attachments, signatures, cursors and receipts |
| myso-core | Capability/organization authority, task escrow and disputes, MyData purchases/access, AI-credit settlement, indexer/social read APIs |
| AI-credit oracle | Model catalog/pricing, reserve/capture/cancel, provider inference, signed accounting and billing reconciliation |

Flow: task/room event → durable automation inbox → scoped coordinator → requirements and authorized recall → versioned work DAG → worker actions → artifact verification → delivery → settlement/receipt reconciliation → encrypted knowledge capture → authorized direct P2P MyData offer/purchase → reuse in a later task.

Chat completion, artifact delivery, buyer acceptance, escrow settlement and knowledge access offers are separate transitions. The model cannot declare those facts true by emitting prose.

## 5. Implementation phases and file changes

### P0 — Freeze scope, source inventory and shared contracts

1. Record current file baselines without Git mutations; preserve the owner's dirty files.
2. Record the confirmed D1–D4 choices and obtain plan approval.
3. Create a capability coverage manifest derived from the actual shared action registry: action ID/version, schema, reads, builder, signer requirements, approval policy, handler, effect parser, MCP tool, OAuth scope, availability and explicit role exclusions.
4. Define versioned shared schemas for execution identity, tasks, rooms, run/step/action, artifacts, receipts, graph manifests/claims, listings and entitlements. Decimal-string/BigInt handling is required for monetary u64 values; do not copy UI number arithmetic into new financial contracts.
5. Use published/workspace library packages rather than absolute sibling paths in deliverable source. Document local linking and package-version requirements without installing or publishing until allowed.

Primary files: `myso-memory/packages/sub-agents/src/action-registry/{types,registry,production-catalog}.ts`, new shared integration contract modules, app `src/core/contracts/**` and `ports.ts`.

Evidence of completion: explicit coverage matrix and typed schema ownership; every requested feature maps to an implementation phase and acceptance item.

### P1 — Rebrand and isolate the fork

- Change visible product title, app metadata, setup/help text, package metadata/lockfile root, Electron product name, desktop category and documentation to MySo Agents/task coordination.
- Update `app/layout.tsx`, `README.md`, `package.json`, `package-lock.json`, `electron-builder.yml`, `electron/main.cjs`, `src/agent/models.ts`, `components/{sidebar,home,setup-dialog,setup-cta,lh-mark}.tsx`, build assets and relevant installer scripts.
- Remove the upstream GitHub update feed and upstream signing/team/notary settings from active release configuration. Leave updates disabled/unconfigured until owner-supplied destinations exist. A renamed app must never update back into LearnHarness.
- Replace all active `LH_*` and `lh:*` app configuration/IPC names in one coordinated main/preload/renderer migration. No compatibility alias ships. Put any legacy LearnHarness import behind the explicit, default-off read-only import wizard.
- Separate new app data location and key storage from upstream installation state. Existing teaching data may be explicitly imported as legacy content; never silently claim a teaching session is a paid task.
- Preserve AGPL license, copyright and attribution, with a separate new product identity. Do not remove upstream notices during branding replacement.

Evidence: source inventory finds no unintended active upstream branding, updater or signing target; legal attribution remains. Visual/icon choices are reviewed as part of UI design, without running the app.

### P2 — Shared authentication, scopes and safe service adapters

- Establish per-request owner/account/organization/agent/platform/network identity from verified credentials.
- Keep wallet/root keys out of agent prompts, tool results, logs and ordinary settings. Reuse bounded delegates and existing custody/session patterns from the messaging chat app.
- Replace the local-only API trust model before hosted access: scoped authorization on chats, tasks, rooms, graphs, exports, events and activity feeds.
- Add injected async ports/adapters for identity, actions, task reads, rooms, memory/graphs, approvals, artifacts, AI credits and automation. Keep app core pure and adapters server-side under the current import architecture.
- Remove unrestricted home-directory file tools from market workers; use an explicit per-run workspace and bounded artifact access.

Files: app `proxy.ts`, `src/server/desktop-access.ts`, `src/server/stores.ts`, new `src/server/integrations/**`, `src/core/ports.ts`, tool factories; memory `packages/mcp/src/{oauth,hosted,credentials,signers}.ts` and authenticated server routes.

Evidence: the same verified scope reaches storage, retrieval, execution, approvals and notifications; a model-supplied ID cannot widen access.

### P3 — Complete the existing automation engine

- Durable event ingestion, per-job claim/ack, stable event identities, persisted retry delay, fencing and owner reconciliation are source-implemented; the broadcast bus is a wake hint and cannot lose queued deliveries. Owner-confirmed replay is permitted only for a reconciliation-held delivery whose action is confirmed never to have executed. Completed and cancelled deliveries are not replayable. Verify restart and failure semantics in the owner-run E2E workflow.
- Persist atomic unique job/event and job/schedule-slot identities, leases, fencing tokens and heartbeats. Serialize each job's event deliveries: running, retry-pending, or reconciling work blocks later events for that job while other events remain durably queued. Cron accepts validated IANA timezones with UTC default, missed slots replay oldest-first, a renewable database lease fences the scheduler scan and slot persistence, and per-job delivery leases serialize dispatch. Source recovery moves expired/exhausted work deliveries to owner reconciliation; web/desktop delivery history pages through older records so those cases remain reachable. Stale running/reconciling runs older than 30 minutes with no linked delivery now have an owner-scoped, audited close path that never replays work. Verify these semantics in the owner-run E2E workflow; deployment/restart behavior remains open.
- Work-run delivery recovery retries through the encrypted operation journal up to the configured claim bound. After exhaustion, the delivery requires owner reconciliation; ambiguous non-work-run effects remain held instead of replaying automatically. The owner can close a stale orphan run as abandoned without replay, or confirm verified success. Deployment/restart behavior remains owner validation.
- Side-effect inputs, canonical hashes, idempotency keys, encrypted operation results, scoped chain receipts and R2 task-upload evidence have source paths. Finish complete run/step output and artifact lineage for every marketplace transition; do not depend on optional audit for successful output retention.
- Work-plan steps may declare exact task and paired jury event suffixes, and completion checks each cited event against finalized task history or an exact verified task receipt for the linked task. Open offers now receive a buyer-only lifecycle template: verify TaskOffered, wait read-only for finalized TaskAccepted, review finalized TaskDelivered, then record a buyer settlement/refund/dispute outcome with matching event evidence. Accepted tasks retain role-aware buyer/seller starter plans. Remaining transition-specific policies must enforce buyer/seller roles and dispute/refund semantics across every action; full owner-run E2E verification remains open.
- Memory binds buyer/seller role from the participant-checked task record and preflights every journaled task action against the linked task and authenticated participant role. Seller-only accept/decline/deliver, buyer-only cancellation/settlement, review-role equality, and participant-only dispute/refund operations are checked before dispatch; native Move still enforces current proposer/counterparty, appeal, status and deadline conditions.
- Persisted multi-event ALL matching, evaluation windows, event debounce and rolling execution caps are source-implemented. Conditional triggers remain rejected, while scheduled triggers use their schedule-specific catch-up rules. Finish remaining event replay semantics and validate trigger behavior through owner E2E scenarios.
- Persisted schedule-slot IDs and cron timezone semantics are source-implemented; cron replays missed slots oldest-first while interval downtime coalesces to the current due bucket. Keep this slot identity shared by due evaluation and action idempotency.
- Automation update, pause/resume, delete, run-now, validate, simulate, cancel and reconciliation APIs have source paths with optimistic versions and redacted scoped responses. Finish any missing lifecycle/error surfaces found by the route-to-MCP audit.
- Reconcile AI-credit usage from exact provider results and live AI-credit authority; work plans and the durable journal must not impose aggregate or per-step spending limits. The owner's October 28 correction supersedes Q33: no owner-set per-run transaction-gas spending ceiling. Transaction gas is a chain transaction parameter; record actual net gas from finalized receipts. The encrypted work journal records exact supported action values for audit/recovery only; live on-chain capabilities, balances and action limits determine authorization. Broader action/token amount reporting remains open and must not introduce off-chain authorization limits. Improve fixed-estimate memory preflight.
- Finish the durable async harness protocol across dispatch, accept, progress, wait, artifact, verify, complete/cancel and recovery. Current unattended work is checkpointed in bounded callback slices and dispatched through durable automation delivery; it still lacks fully asynchronous orchestration and complete lifecycle recovery.
- Issue each accepted durable run a short-lived, revocable worker credential bound to its owner/account/agent/run and permitted work scope. Never persist the owner's OAuth bearer token for a queued run. Revalidate live chain capabilities, spend policy, run state, credential expiry/revocation and the current MyData authorization at worker boundaries; the credential does not grant owner-wallet signing or bypass the source consent stored for that run. For scheduled automation, the owner configures the standing graph/room/artifact source consent before enabling the job; each execution receives a separate credential carrying only those selected flags.

Files: `services/automation/src/{main,handlers,store,executor,trigger_eval,registered_action,event_bus,lib}.rs`, new SQL migrations, `services/server/src/automation_proxy.rs`, `services/automation-sidecar/src/{bridge,verify,delegates}.ts`.

Evidence: durable state transitions and migration contracts cover restart/delivery races; owner-run tests are listed, not executed by the agent.

### P4 — Complete MCP actions and all read/list coverage

Historical October 26, 2026 baseline: `myso-memory/packages/sub-agents/src/action-registry/production-catalog.ts` reported catalog 1.30.0 with 114 actions. The current implementation status and action coverage docs track subsequent changes and are authoritative for current catalog counts. `assets.burn_object.v1` is source-enabled for zero-balance framework `Coin<T>` only. The PoC beneficiary transfer now has a service-authenticated MCP OAuth/proposal/job workflow and a scoped proposal receipt that independently checks the live configured oracle, exact beneficiary, identity hash, recipient, proposal event and checkpoint; the recipient also has a separate acceptance action and receipt. Its oracle tools remain hidden unless the server feature flag, service key, PoC config and trade capability are all present. Recompute action and read coverage from the current registry at every phase gate; these counts are snapshots, not architecture.

- Generate typed tools from the shared registry for enabled actions, including dedicated task and juror execution. Preserve role-specific operator authority for jury cranks.
- Implement remaining catalog builder/adapter prerequisites and actual execution paths. Follow current registry and platform authority rather than stale action counts. DEX scope is only existing MySo Orderbook v3 PTBs through fixed adapter builders; no Move changes, margin, bridge or unrelated DEX. Exclude profile/comment/repost tipping; retain only post tipping. High-authority actions require deployment flag, OAuth scope, operator role and configured approval.
- Add complete task lifecycle and dispute/evidence/refund negotiation tools. Acceptance carries the exact seller-visible `termsDigest` as the expected offer version; the Move entry aborts if that digest or offered status changed before execution. Preserve this check through UI/MCP retries and verify stale-offer denial in owner E2E.
- Add automation management, AI inference/credits, graph/knowledge market, room/member/message, artifact, workflow, approval and audit tools.
- Add missing reads/lists: tasks/offers/assignments, task config/history/artifacts/receipts, agents/capabilities/budgets/expiry/reputation, organizations/roles/invitations/memory permissions, rooms/members/history/digests/read receipts, jury cases/duties/rounds/verdicts, AI balance/catalog/usage/reservations, graph/listing/entitlement/version/revenue records, social profiles/posts/comments/feed/search, workflow/approval/audit records.
- Reuse social-server readers and messaging SDK methods already present; factor shared clients out of chat-app code rather than duplicating route/schema assumptions.
- Enforce bounded cursor pagination, stable ordering, redaction, structured output/error types, idempotency, cancellation, long-run status and per-tool network/indexer compatibility metadata. Advertise a tool only when handler + builder + deployment config are all ready; check authority again during execution.
- Filter advertised tools by implementation/deployment, OAuth scope, agent capability, account/org/platform scope and approval policy. Re-check policy when executing; listing is not authorization.

Files: `myso-memory/packages/mcp/src/{tools,social-gateway,server,hosted,cli,oauth,errors}.ts`, new domain gateway modules, SDK methods, sub-agent registry/builders, relayer routes, `myso-core/crates/myso-social-server/src/server/handlers/**` and corresponding readers/indexers.

Evidence: every catalog action and requested query has an actual typed path, role policy and schema; no fake success or “not implemented” tool counts as coverage.

### P5 — Connect the harness to MySo AI credits

- Extend the signed per-agent memory-relayer gateway and SDK with structured messages, tools, tool results and output calls from the existing oracle core.
- Bind owner/account/agent/balance/model to authenticated execution context, not client-supplied unchecked fields or a shared environment identity.
- Persist model-call operation keys before reserve/provider dispatch. Preserve the key through retries; do not generate a new UUID for the same logical call.
- Implement a pi engine adapter emitting correct pi events and tool/usage shapes from non-streaming completions. Show honest waiting/completed UI; do not pretend received text chunks are provider streaming.
- No AI streaming in v1; use non-streaming completions and an honest wait state.
- Expose balance, models, preflight, reserves/captures/cancel, usage, approval and receipt reads through MCP and app controls. Route provider use according to data classification.

Files: app `src/agent/models.ts`, `src/core/settings*.ts`, `src/server/model-catalog.ts`, new MySo provider adapter; memory `packages/sdk/src/{memory,types}.ts`, `services/server/src/{routes,ai_spend}.rs`; core oracle `src/{server,openai_provider,reservation_ledger,settlement_coordinator}.rs` where required.

Evidence: typed tool-call and billing mappings, multi-account auth binding and persisted retry identity. No live provider invocation.

### P6 — Rooms, encrypted chat and artifact transport

- Use `@socialproof/myso-messaging-stack` encryption/signatures, groups, history/subscriptions, attachments, receipts and key rotation.
- Preserve D10 in the invite UX and API: disclose that a new reader can decrypt existing room history before granting membership, require a deliberate owner/admin action, and verify the finalized membership change. Do not claim that key rotation removes historical access from a reader who already decrypted or retained plaintext.
- Extract reusable agent-room, digest verification, task discovery and automation-client logic from `myso-messaging-stack/chat-app/src/lib/agents` into shared libraries.
- Support task/room creation in either order: task offers may pin a pre-existing group, then `messaging.bind_room_to_task.v1` validates the reciprocal relation and task-party authority, writes room metadata and emits an indexable bind event. Membership and organization access remain explicit checks.
- Deliver requirements, worker progress, artifacts and receipts as versioned room events with durable cursors and dedupe. Do not trigger agent loops repeatedly on their own status messages.
- Verify content hashes and sender signatures separately from pointer/sequence existence. Unmatched or unverifiable evidence remains unknown.
- Keep graph snapshots and private knowledge plaintext out of public room metadata. Access to a room does not imply ownership of all purchased knowledge used by one worker.

Evidence: typed room-message/artifact contracts, membership-aware crypto flow, receipt references and delivery cursor ownership.

### P7 — Encrypted evidence graph and buyable knowledge

- Preserve propositions/arguments and graph rendering, but introduce versioned typed entities/relations and immutable evidence records for tasks, agents, orgs, rooms, artifact checks and chain receipts.
- Replace assistant-prose-only extraction for work runs with an authorized evidence projection including user requirements, verified tool outputs, artifacts and receipts. Version extraction schemas and coverage keys.
- Separate identity linking from truth/evidence verification. Track asserted/verified/disputed/superseded claims, temporal validity and transitive source dependencies.
- Replace synchronous global graph ports with scoped async services and atomic graph+coverage commits. Use MyData encrypted manifests/batches with protected materialized traversal/recall caches.
- Implement the versioned `GraphManifest`: typed entities, relations, evidence references, coverage keys, encryption-envelope references, per-node source-rights claims, canonical manifest hash and seller-signed publication record. Pin every listing to `(graph_id, version_hash)`; no `latest` alias. Subscriptions include future versions only when the seller explicitly offers a series/stream entitlement.
- Use existing MyData one-time/recurring listing, purchase, grant/revoke and approval policies. Keep metadata-only graph-offer discovery available with an explicit unverified-preview warning. Seller offer UI must disclose version, audience, price, subscription mode, preview and one of the acknowledged revocation templates. Do not treat the current preview as a verified offer or allow full graph purchase until manifest validation, source-rights checks, signature binding and offer UI are complete.
- Public discovery is in scope through redacted previews or hashed summaries. Purchases remain direct P2P and require the buyer to select an organization with no default. Persist the selected audience immutably; allow personal purchase only if the deployed MyData contract supports it.
- Listing requires org-admin authority or a `sell_graph` delegate, and fails if the signed seller claims do not cover each entity and its evidence. Verify the seller publication signature against the seller's authenticated MySo signer identity and recheck current selling authority live. These signed source-rights claims are seller assertions; separate source-owner signatures are not required. Do not let organization membership alone grant selling rights.
- Implement purchase → entitlement → key release → protected cache. Revoke future key release and invalidate server caches; do not claim revocation retracts decrypted exports.
- Apply privacy policy to prompts, extractor/auditor, compaction, exports, logs, artifacts, search, snapshots and event notifications. A plaintext JSONL replica is not acceptable private storage.

Files: app `src/core/{contracts/graph,coverage,graph,graph-deletion}.ts`, `src/agent/subagents/extraction.ts`, graph tools/routes/components; new memory graph/manifest/entitlement services and persistence migrations; core `mydata.move`, MyData policies and existing social readers/indexers; registry marketplace builders.

Evidence: format/version, source rights, entitlement-to-key policy, revocation propagation and evidence preservation are explicit and implemented across every read/export path.

### P8 — Replace the teaching loop with task coordination

- Replace prober/teacher/practice as the normal product flow with requirements/intake, coordinator/planner, bounded worker, verifier and knowledge-curator roles.
- Convert lesson DAGs to versioned work DAGs with assignees, dependencies, authorized inputs, budgets, deadlines, acceptance criteria and output manifests.
- Work statuses derive from durable engine events. Human waits represent missing requirements, policy approval or review; quiz outcomes never mark work complete.
- Persist intent before side effects and fail the action on required persistence failure. Keep room chat reconstruction separate from authoritative task/run state.
- Model task offer, accept, execute, verify, deliver, settle/refund/dispute and knowledge access offers explicitly. Support both buying work and fulfilling work.
- Integrate organization-scoped agent selection/capabilities/reputation and policy-bound market matching; recheck task terms/version before accepting or paying.
- Retain useful research/PDF/visual/demo generation as bounded artifact-producing workers. Migrate/remove teaching-specific prompts/cards/routes from active navigation; preserve only explicit legacy data import behavior.

Files: `src/server/{chat-handler,turn-service,jobs,turn-liveness,turn-runs}.ts`, `src/agent/{teacher-agent,tools,prompt-segments}.ts`, new coordinator/worker/verifier factories and prompts, `src/core/{input-events,native-messages,pending,phases,plan-tree,view}.ts`, related contracts and streams.

Evidence: normal turns act on task state and actual acceptance criteria; no learning loop remains as a required execution gate.

### P9 — Task/room/knowledge product surfaces

Approved primary navigation: Home (chat field, overview stats, activity), Marketplace (Tasks and Rooms), Knowledge, Agents (Organizations, Automations, Activity), Settings.

- Home gives actionable task/room/run state rather than lesson suggestions.
- Task detail shows scope/price/terms, DAG progress, assignees, verified artifacts, receipts and dispute/review controls.
- Room detail shows encrypted conversation, members, task binding and verification.
- Knowledge detail shows graph/source evidence, privacy/ownership, listing terms, preview/purchase/access/version and revocation state.
- Agent/org controls show effective policies, delegates and approval/budget state.
- Automation controls expose supported trigger semantics and run lifecycle honestly.
- Keep implementation internals out of normal user flows; present unresolved outcomes and approvals in plain language.

Reuse the existing shell, graph canvas and plan rendering where appropriate; use the relevant frontend design skills at implementation time. Do not build screens that only display seed/mock state for unimplemented services.

### Revalidated execution sequence — October 27, 2026

The owner-approved P0–P10 scope remains authoritative; this sequence orders its still-open work against the current dirty source trees. Do not reset or overwrite existing changes.

1. **Refresh the shared source-of-truth manifest.** Keep the current on-chain action catalog and MCP action coverage tied to the current `production-catalog.ts`; add a parallel query manifest for social-server, messaging, automation, AI-credit, task/room and receipt resources. Record signer, role, OAuth scope, required config, read dependencies, builder, server validation, effect verifier and deployment gate. `assets.burn_object.v1` and `account.rotate_owner_key.v1` are enabled; do not count them as remaining catalog gaps.
2. **Complete native/action prerequisites before MCP advertisement.** In `myso-core`, finish platform transfer and fee-recipient change under `PlatformAdminCap`, organization MYSO treasury access/withdrawal with owner/admin authority, live-balance limits, and a deposit path/read so a treasury can actually be funded. Keep current task-recipient snapshots intact. Complete the accepted PoC beneficiary ABI with an oracle proposal path, recipient-wallet acceptance, final claim binding, and event reader. For owner-key migration, use an old-wallet proposal followed by new-wallet reference updates and profile acceptance. The normal acceptance PTB should include the exact shared `SubAgent` and `AgenticOrganization` inputs, update each reference, and finalize in one atomic PTB. If protocol input/gas limits require staged PTBs, pending progress is explicit; the recipient can resume, while either wallet can roll back changed references and only the old wallet can cancel after all rollbacks. Move validates manifest lengths against `table::length`, verifies each ID belongs to the account registry, rejects duplicates, and commits the `MemoryRegistry.accounts` key, linked profile `UsernameRegistry.address_profiles` row/owner, account owner, and all registered child `principal_owner` fields only when the complete set is covered. Independently transferable objects remain a separate explicit wallet-selected transfer list. The app reads the exact on-chain manifest/progress tables and builds/recovers this flow. Account migration requires the actual old/new owner wallets; the separate messaging MyData custody vault holds delegated agent signing keys and must not expose key material to MCP/server processes. MySo core verifies protocol multisig signatures. The web/desktop owner-migration UI derives a native multisig owner address from selected wallet account keys and signs recipient acceptance/rollback batches through each selected wallet. The generic approved-action MCP flow now prepares and submits the old-owner proposal with `SOCIAL_MEMORY_REGISTRY_ID`, owner approval, and scoped native-event receipts; recipient acceptance and rollback remain wallet-signed in the app. Keep protocol multisig setup outside the on-chain action catalog: `account_configure_multisig` is a read-only MCP descriptor utility, and the web/desktop owner-migration flow now requires the MCP descriptor to match its locally wallet-key-derived configuration before use. Never invent a Move entry point for protocol-level multisig. The generic owner-approval inbox now signs approval intents and prepared transactions with the configured protocol multisig signer set, with local intent-aware verification. For each supported action, wire SDK/PTB → server policy/prepare → approval/signing → scoped finalized receipt → MCP tool, then add it to the advertised capability manifest.
3. **Close read/list coverage and identity policy.** Inventory every domain endpoint and field in MySo core/social readers, messaging, organizations/roles, task/rooms, automation, AI-credit and receipts. Implement bounded pagination, stable ordering, redaction and typed errors; prove the acting account/agent/org and live role for sensitive reads. Indexed summaries must remain clearly distinct from fullnode authority and transaction receipts.
4. **Finish durable automation and task execution in the existing service.** Complete durable run/step/action outputs and cross-deployment progress/cancel/recover. Stable schedule slots, renewable distributed tick fencing, oldest-first cron recovery, per-job serialization, bounded delivery retries and owner-confirmed reconciliation/requeue are source-implemented. Cron accepts validated IANA timezones (default UTC) and missed cron slots replay oldest-first; interval downtime coalesces to the current bucket. The scheduler resumes cron from the exact persisted slot key, not a delayed run's start time. Ambiguous failures and expired delivery leases move matching run history into reconciliation, including older source-event IDs resolved through the saved event envelope; owner resolution updates both records. Stale runs older than 30 minutes with no linked delivery can be owner-confirmed as successful or closed as abandoned without replay; web/desktop delivery history pages through older records. Verify the lifecycle in the owner-run E2E workflow. Stable slot dedup bounds a job to one active delivery plus at most one waiting scheduled slot, and explicitly canceling a pending schedule slot advances the cursor past it. A work-run sidecar dispatch handles one resumable model slice per request, while the automation worker advances stable continuation IDs under the persisted delivery lease; each slice has a 25-minute credential deadline and the automation HTTP request allows 26 minutes. Bind task acceptance to the exact offer `termsDigest` read by the seller and pass it as Move’s `expected_terms_digest`; the chain rejects changed terms, non-offered status, expired windows or inactive sellers. Connect run state to verified delivery, artifacts and settlement; use R2 for encrypted artifacts.

Each unattended work-run sidecar call performs one app turn, polls/retries only that same fenced request ID, and revokes its run-scoped action-worker credential on exit. The automation executor enforces the configured total model-turn limit and derives every continuation request ID deterministically; restarting a work-run delivery replays the same chain through the encrypted journal. A single slice that cannot complete within 25 minutes returns to durable delivery retry/reconciliation; automation delivery lease renewal continues while the executor runs, and the HTTP timeout exceeds the sidecar deadline. The automation store requeues expired work-run delivery leases up to five claims with a UUID derived from the durable job/event key; after the retry bound, delivery enters reconciliation. The turn fingerprint binds worker/run identity and normalized turn input but excludes the rotating bearer credential. A repeated event key bypasses another cooldown/cap charge for that same work run, while new event keys remain subject to current policy. The Automations screen exposes delivery-level resolution with an audit note; `confirmed_not_executed_retry` is allowed only after the owner verifies that the delivery did not execute. The Work screen displays exact pending/reconciling operation IDs, action names, tool-call IDs, idempotency keys, input hashes and optional AI provider-reservation metadata from the encrypted scoped journal; exact supported MYSO action amounts are audit metadata, while on-chain permissions and spend limits authorize chain actions. It resolves each server-issued key to the same account/agent's registered chain action, checks the action-specific configured-fullnode receipt, and atomically records only terminal success/failure in the encrypted journal while refusing active-lease races; unknown, pending-finality, mismatched-input and unregistered outcomes stay held. Task deliverables use a separate participant-ledger/R2-byte verification and exact-file recovery path. Other action types retain manual delivery reconciliation. Deployment migration application, worker restart/timeout behavior and production gateway/runtime behavior remain owner validation items.
5. **Integrate the existing AI-credit oracle through the scoped SDK/server path.** Preserve structured messages/tools and non-streaming v1 behavior; bind calls to authenticated account/agent/org, persist idempotency before dispatch, reconcile reserve/capture/cancel and expose model/balance/usage/receipt reads. Enforce data-classification rules before prompts can include graph or room content. Typed private-graph reads may enter hosted inference only under D11's explicit interactive or automation source consent; room messages and task artifacts keep their separate source-consent flags. Strip private source plaintext before durable checkpoints and require fresh interactive consent when a prior private transcript is resumed. Provider retention and downstream-derived data policy remain open.
6. **Complete encrypted room and organization workflows.** Extract shared APIs from the messaging SDK/chat app; fill membership and role proofs, message subscriptions, event signatures, attachments/reactions/read/delivery receipts, cursor recovery, key rotation/removal and cached-key invalidation. Connect room lifecycle to task workflow without trusting chat text as task state.
7. **Complete pinned-version graph lifecycle and safe harness use.** Finish immutable-version purchase/grant/revoke recovery views, subscription renewal and buyer lifecycle, protected cache invalidation, source-rights and derived-data retention boundaries, and transactional knowledge capture. The owner selected one immutable graph version per purchase; series-stream entitlements and any latest-version alias are unsupported, and later publications require a separately verified offer and purchase. Keep public offer discovery active as an unverified metadata-only preview; only verified signed offers may reach purchase. The coordinator may use decrypted graph material only under D11's explicit per-run/automation source consent and exact live MyData access checks; downstream sharing requires separate consent, and provider retention must be disclosed without claiming revocation can recall sent plaintext.
8. **Finish the product loop and rebrand audit.** Remove active teaching/prober flows from default product paths; route chat through task intake/planning/coordinator/worker/verifier/curator, with actual marketplace task states and artifact/receipt evidence. Finish web and desktop UI for marketplace, rooms, knowledge, agents/orgs, automation, approvals and activity. Audit active labels, package/update targets and data separation for residual LearnHarness identity.
9. **Compile-only cross-repo review and owner handoff.** Compile/type-check changed targets; do not run tests, Move tests, services, smoke scripts, simulators or runtimes. The owner-requested `myso move test -e testnet` has a historical pass record of 774 tests on October 26, 2026, but the owner later directed that testing and runtime verification remain owner-run, so do not rerun it. Do not submit transactions or deploy. Make no commits or pushes, and keep every remaining runtime/deployment check explicit for owner verification.

**Multisig is not a chain action:** the production catalog no longer advertises `account.configure_multisig.v1`; the read-only MCP `account_configure_multisig` utility is used by the owner-migration UI and its descriptor must equal the locally derived wallet signer set. Native multisig configuration is the signer set and threshold used for combined chain signatures; no Move registration entry exists. Owner migration uses those signatures for acceptance/rollback, and the generic owner-approval inbox now supports the same signer set for approval-intent and prepared-transaction signing. `account.rotate_owner_key.v1` has a generic MCP approved-action proposal path in addition to the compiled Move migration protocol, SDK PTB builders, paginated manifest/progress reads, and scoped proposal/acceptance receipts. The MCP path requires current-owner approval and a configured `SOCIAL_MEMORY_REGISTRY_ID`; the server limits the proposal to the existing 7,000-byte transaction-kind policy. Recipient acceptance and rollback remain wallet-signed in the web/desktop UI, which batches at most six references per signature, resumes from on-chain progress, verifies each batch, and supports rollback before cancellation. Independently transferable objects use a separate explicit wallet-selected transfer list with one owner-approved transfer and scoped finalized object-change receipt per object; they are intentionally separate from the atomic registered-reference migration. `poc.transfer_beneficiary_rights.v1` has the verified-identity proposal, recipient wallet acceptance and scoped receipts source-implemented; deployment/runtime verification remains open. Organization treasury grant/revoke, deposit, balance/access reads and withdrawal are source-implemented with owner-wallet signing; admin signing, deployment and runtime verification remain open. `bridge.initiate_transfer.v1` remains intentionally deferred. Profile tipping remains excluded; only post tips are allowed.

### P10 — Compile review and owner handoff

- Inspect package scripts and applicable Next.js bundled guidance before code changes.
- Use TypeScript compilation/type checking and Rust compile checks for changed targets. Do not run smoke scripts, simulators or `desktop:dist`; packaging remains outside validation.
- The owner specifically requested `myso move test -e testnet`; this passed all 774 tests on October 26, 2026. Do not deploy or submit transactions. Keep external deployment and production runtime verification open.
- Record exact checks performed, unperformed runtime tests, dependency versions, migration ordering and service configuration names without secrets.
- Provide the owner a manual verification matrix: tenant isolation, purchases/entitlements, restarted runs, event replay, unknown transactions, duplicate AI calls, key rotation/revocation, graph privacy/exports, receipt checks, all MCP action/list scopes and responsive UI.
- The owner-run matrix must include four correlated end-to-end journeys, not only component checks: (1) task offer → accepted version → durable worker run → verified R2 artifact → buyer review/dispute → settlement and matching receipts; (2) explicit room invitation → signed history/message/attachment context → durable event processing → key rotation/removal, with task state independent of chat prose; (3) signed graph publication → version-pinned offer → audience and terms selection → cap/approval-gated MySo purchase → entitlement/key release → revoke/expiry; and (4) encrypted unattended run → action_worker-scoped sidecar execution → fenced restart/replay → receipt reconciliation and credential revocation. For each, verify web and desktop where applicable, two-account/org isolation, positive and denial cases, and correlated IDs/digests across app, MCP/Memory, automation, messaging, core/fullnode, AI-credit and R2. The exact evidence and stop conditions are recorded in `myso-agents-implementation-status.md` under “Cross-service end-to-end acceptance journeys.”
- Refresh architecture/readme/assessment docs around final implementation. Preserve AGPL attribution and source-offer requirements without publishing anything.

Compilation proves syntax/type integration only. The owner is responsible for runtime validation by request; label runtime readiness unverified until their evidence is available.

## 6. Requirements-to-completion checklist

- [ ] R1 — MySo Agents identity throughout active UI, packaging, provider attribution and docs; upstream update/signing targets removed.
- [ ] R2 — Existing memory, messaging, core, automation and AI-credit implementations integrated through verified scoped contracts.
- [ ] R3 — Complete catalog action execution, including the currently blocked builders/adapters and intentionally isolated operator controls.
- [ ] R4 — Complete read/list/query coverage for every product domain, bounded and scoped.
- [ ] R5 — Durable automation inbox/run/step/action/recovery and full trigger/lifecycle semantics.
- [ ] R6 — Task marketplace coordination replaces the normal teaching loop end to end.
- [ ] R7 — Rooms support encrypted work conversation, members, artifacts, history, verification and receipts.
- [ ] R8 — Encrypted graphs include evidence, provenance, scopes and revocation-aware derivation.
- [ ] R9 — Knowledge listings, terms, preview, purchase, access/copy mode, versions and receipts function through actual MyData direct P2P one-time/subscription entitlements, without depending on an unfinished public marketplace.
- [ ] R10 — AI tool calls use verified account identity, stable call keys, credits and reconciled usage.
- [ ] R11 — Live on-chain organization/delegate/approval/spend authority applies at tools, storage, context construction and events; no app-side, work-run or step-level spending caps are invented. Subscription payout-recipient changes apply only to future payments; already collected or prefunded funds stay put.
- [ ] R12 — No forbidden runtime/test/commit/push/deploy actions; compile results and unverified runtime cases documented.
- [ ] R13 — Existing user changes preserved; no fabricated Git remotes, service endpoints, deployed IDs or signing identities.
- [ ] R14 — Owner handoff includes migrations/configuration, action coverage manifest, source attribution and manual validation matrix.

For each checked requirement, completion notes must identify changed files and the actual evidence. Planned work, stubs, empty tool results and source inspection alone do not establish implemented functionality.

## 7. Sequencing and review boundaries

First reviewable milestone: approved decisions and contract/coverage manifest, safe branding, authenticated automation/task reads and existing task actions. Next: durable work execution and scoped rooms/AI. Next: private graph market and full work UI. Final: all remaining catalog actions/list gaps, compile-only cross-repo review and owner handoff.

These are intermediate delivery points, not definitions of success. The entire checklist remains the goal.

The multi-repository scope is larger than a few adapters. The original inventory counted 37 blocked catalog actions before implementation. The current source inventory records 113 of 114 on-chain actions with executable dedicated or generic approved-action routes; the sole unavailable action is `bridge.initiate_transfer.v1`, explicitly deferred by the owner. Do not carry forward the older five-action/two-active-gap count. The remaining source work is primarily field-by-field authorization parity outside the audited read families, buyer lifecycle/revocation propagation beyond active-view cleanup, and the task-market harness conversion. Bounded work-run recovery and owner reconciliation now have source paths; deployment/runtime behavior and the owner's correlated end-to-end acceptance journeys remain unverified. The earlier pilot estimate is not a commitment for complete platform coverage.

**Revalidation note — October 27, 2026:** bounded work-run retry exhaustion and delivery-lease recovery now have a source path: exhausted or expired deliveries enter owner reconciliation, registered chain actions can be checked against configured fullnode receipts, task uploads use participant-ledger/R2 byte verification, and only the exact saved file can be retried. The remaining gap is correlated owner E2E verification of those recovery paths, plus deployment behavior, rather than a missing recovery state. Graph-access revocation now clears matching plaintext from the active Knowledge view and broadcasts a scoped invalidation to all open same-origin tabs after a finalized receipt. Source review found no persisted graph-plaintext cache in the app. Provider-side retention and already exported or derived content remain outside app control and require policy/runtime verification. The user reconfirmed that a room-authorized agent may archive with live `PermissionsAdmin` after explicit owner confirmation in the app.
