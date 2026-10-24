# MySo Agents implementation plan

Status: proposed for owner review. No product source changes have been made. October 24, 2026.

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
| New app | `ProjectYZ/myso-agents-app` | Unrenamed LearnHarness 0.3.6 source; no `.git` or `node_modules` present |
| Messaging | `ProjectYZ/myso-messaging-stack` | HEAD `bdb008e2d5fcb9784af25f165575f2bf694da1cd`; clean at inspection |
| Memory/MCP/automation | `ProjectYZ/myso-memory` | HEAD `492d3532c05f307297020f5be31cba9ba3740e40`; existing untracked `.cursor/` |
| Core/contracts/indexers/oracle | `ProjectYZ/myso-core` | HEAD `1c39abf1a00d4bc4608b41f24584c49b8fda5ca9`; existing modified/untracked `.cursor` planning files |

The literal folders `myso-agent-automations`, `myso-ai-credit`, and `myso-message-stack` were not found alongside these repositories. The confirmed implementations are `myso-memory/services/automation`, `myso-memory/services/automation-sidecar`, `myso-core/crates/myso-ai-credit-oracle`, and `myso-messaging-stack`. The owner confirmed these existing implementations are the intended repositories.

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

This is read-only source evidence, not implementation or runtime validation. No product source changed while producing it. Implementation still awaits owner plan approval.

## 3. Confirmed product decisions and remaining review

D1 — Confirmed: support both hosted web and the existing desktop app.

D2 — Confirmed: buy private knowledge through existing **direct peer-to-peer MyData access**, supporting one-time purchases and subscriptions as the contracts permit. Use encrypted entitlement-gated access, not a new copy/resale product. Knowledge can be offered by reference directly between peers or in an authorized room. Do not make this depend on unfinished public marketplace search, matching or catalog infrastructure. Revocation affects future access and protected caches, not information already decrypted or exported.

D3 — Confirmed: agents may purchase and settle automatically within owner-approved capabilities, budgets and policies. Escalate only when existing authority/approval limits require it. Do not introduce a per-payment signature requirement for actions already authorized by those limits.

D4 — Confirmed: use automation in `myso-memory/services/automation` plus its sidecar, AI credits in `myso-core/crates/myso-ai-credit-oracle`, and `myso-messaging-stack`.

Product naming, within the variants the owner already supplied: visible product **MySo Agents**, package/slug **myso-agents**, code identifier **MySoAgents**. New desktop bundle identity, website/help URL, release repository/update feed and signing identity still need owner values before distribution configuration is finalized; do not invent them or retain upstream release/signing targets. These do not prevent source implementation after plan approval.

Offer terms must explicitly identify the seller, graph/version, one-time versus subscription price, duration and supported revocation policy. Use existing MyData economics rather than inventing fees or resale licenses. There is no assumed permission to sell private source material or organization knowledge.

Plan approval is still pending; the product answers above are not treated as blanket approval of every implementation proposal.

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
- Introduce product-owned configuration and IPC names together; inventory existing `LH_*` and `lh:*` usages before migration. Keep any compatibility aliases explicit and bounded; avoid a partial rename that breaks the preload/main/renderer contract.
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

- Add durable event claim/ack/replay/dead-letter state. Persist event-to-run enqueue transactionally; the current broadcast bus must become a notification optimization rather than the only delivery path.
- Persist atomic unique job/event and job/schedule-slot identities, leases, fencing tokens, heartbeats and overlap/catch-up policy.
- Implement stale-run recovery and operation reconciliation; distinguish retryable failure from unknown transaction outcome.
- Persist action inputs/canonical hash, idempotency key, output/artifact, transaction digest, finality and receipt links in run/step records. Do not depend on optional audit for successful output retention.
- Implement conditional/debounce/window-cap/replay semantics and persisted multi-event ALL state; reject unsupported settings until implemented.
- Use one persisted canonical schedule slot for both due evaluation and action key generation; add timezone semantics.
- Add update/pause/resume/delete/run-now/validate/dry-run/cancel/replay APIs, optimistic versions and redacted responses.
- Reconcile actual AI/gas/transfer spend and cumulative limits; keep amounts separate. Improve fixed-estimate memory preflight.
- Add a durable async harness work action/protocol: dispatch, accept, progress, wait, artifact, verify, complete/cancel. A long task cannot be one short webhook response.

Files: `services/automation/src/{main,handlers,store,executor,trigger_eval,registered_action,event_bus,lib}.rs`, new SQL migrations, `services/server/src/automation_proxy.rs`, `services/automation-sidecar/src/{bridge,verify,delegates}.ts`.

Evidence: durable state transitions and migration contracts cover restart/delivery races; owner-run tests are listed, not executed by the agent.

### P4 — Complete MCP actions and all read/list coverage

Start from the 110 action IDs in the inspected catalog: 63 Tier 1 enabled, 20 Tier 2 blocked on builders/adapters, 27 Tier 3 with 10 enabled and 17 blocked. Recompute from current code before implementation; do not freeze counts as architecture.

- Generate typed tools from the shared registry for enabled actions, including dedicated task and juror execution. Preserve role-specific operator authority for jury cranks.
- Implement all remaining 37 catalog builder/adapter prerequisites and actual execution paths. Includes payments/tokens, subscriptions/access/MyData sharing, markets/trading, storage, DEX/bridge, governance, treasury, ownership and account controls. Design reviews may be needed for newly exposed high-authority actions; do not replace them with arbitrary programmable calls.
- Add complete task lifecycle and dispute/evidence/refund negotiation tools.
- Add automation management, AI inference/credits, graph/knowledge market, room/member/message, artifact, workflow, approval and audit tools.
- Add missing reads/lists: tasks/offers/assignments, task config/history/artifacts/receipts, agents/capabilities/budgets/expiry/reputation, organizations/roles/invitations/memory permissions, rooms/members/history/digests/read receipts, jury cases/duties/rounds/verdicts, AI balance/catalog/usage/reservations, graph/listing/entitlement/version/revenue records, social profiles/posts/comments/feed/search, workflow/approval/audit records.
- Reuse social-server readers and messaging SDK methods already present; factor shared clients out of chat-app code rather than duplicating route/schema assumptions.
- Enforce bounded cursor pagination, stable ordering, redaction, structured output/error types, idempotency, cancellation, long-run status and compatibility metadata.
- Filter advertised tools by implementation/deployment, OAuth scope, agent capability, account/org/platform scope and approval policy. Re-check policy when executing; listing is not authorization.

Files: `myso-memory/packages/mcp/src/{tools,social-gateway,server,hosted,cli,oauth,errors}.ts`, new domain gateway modules, SDK methods, sub-agent registry/builders, relayer routes, `myso-core/crates/myso-social-server/src/server/handlers/**` and corresponding readers/indexers.

Evidence: every catalog action and requested query has an actual typed path, role policy and schema; no fake success or “not implemented” tool counts as coverage.

### P5 — Connect the harness to MySo AI credits

- Extend the signed per-agent memory-relayer gateway and SDK with structured messages, tools, tool results and output calls from the existing oracle core.
- Bind owner/account/agent/balance/model to authenticated execution context, not client-supplied unchecked fields or a shared environment identity.
- Persist model-call operation keys before reserve/provider dispatch. Preserve the key through retries; do not generate a new UUID for the same logical call.
- Implement a pi engine adapter emitting correct pi events and tool/usage shapes from non-streaming completions. Show honest waiting/completed UI; do not pretend received text chunks are provider streaming.
- Add true streaming only with defined billing, disconnect, retry and reconciliation semantics. It is a capability, not a requirement for a functioning tool loop.
- Expose balance, models, preflight, reserves/captures/cancel, usage, approval and receipt reads through MCP and app controls. Route provider use according to data classification.

Files: app `src/agent/models.ts`, `src/core/settings*.ts`, `src/server/model-catalog.ts`, new MySo provider adapter; memory `packages/sdk/src/{memory,types}.ts`, `services/server/src/{routes,ai_spend}.rs`; core oracle `src/{server,openai_provider,reservation_ledger,settlement_coordinator}.rs` where required.

Evidence: typed tool-call and billing mappings, multi-account auth binding and persisted retry identity. No live provider invocation.

### P6 — Rooms, encrypted chat and artifact transport

- Use `@socialproof/myso-messaging-stack` encryption/signatures, groups, history/subscriptions, attachments, receipts and key rotation.
- Extract reusable agent-room, digest verification, task discovery and automation-client logic from `myso-messaging-stack/chat-app/src/lib/agents` into shared libraries.
- Extend MCP/registry group creation for room kind/task binding; represent membership and organization checks explicitly.
- Deliver requirements, worker progress, artifacts and receipts as versioned room events with durable cursors and dedupe. Do not trigger agent loops repeatedly on their own status messages.
- Verify content hashes and sender signatures separately from pointer/sequence existence. Unmatched or unverifiable evidence remains unknown.
- Keep graph snapshots and private knowledge plaintext out of public room metadata. Access to a room does not imply ownership of all purchased knowledge used by one worker.

Evidence: typed room-message/artifact contracts, membership-aware crypto flow, receipt references and delivery cursor ownership.

### P7 — Encrypted evidence graph and buyable knowledge

- Preserve propositions/arguments and graph rendering, but introduce typed entities/relations and immutable evidence records for tasks, agents, orgs, rooms, artifact checks and chain receipts.
- Replace assistant-prose-only extraction for work runs with an authorized evidence projection including user requirements, verified tool outputs, artifacts and receipts. Version extraction schemas and coverage keys.
- Separate identity linking from truth/evidence verification. Track asserted/verified/disputed/superseded claims, temporal validity and transitive source dependencies.
- Replace synchronous global graph ports with scoped async services and atomic graph+coverage commits. Use MyData encrypted manifests/batches with protected materialized traversal/recall caches.
- Use existing MyData one-time/recurring listing, purchase, grant/revoke and approval policy contracts. Add graph media/schema metadata, encrypted version manifest, seller-controlled shareable offer/preview, existing access terms and price, entitlement checks, purchase receipts and revenue/indexer views.
- Implement direct peer-to-peer MyData access offers for a named graph/version: one-time purchase and recurring subscription, with on-chain entitlements and authorized key release. One-time access is not represented as a transferable/resellable private copy. A public discovery catalog is optional future product work and is not a dependency or a substitute for direct P2P access.
- Recheck sharing/resale authority of every source; support org-owned graphs and prevent one member from selling another member's private data.
- Revoke future retrieval and invalidate dependent caches/projections after entitlement/source access changes. Do not claim revocation retracts already decrypted copies.
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

Proposed primary navigation: Marketplace, Tasks, Rooms, Knowledge, Agents, Organizations, Automations, Activity/Receipts, Settings. Confirm information architecture in the approved UI design before implementing layouts.

- Home gives actionable task/room/run state rather than lesson suggestions.
- Task detail shows scope/price/terms, DAG progress, assignees, verified artifacts, receipts and dispute/review controls.
- Room detail shows encrypted conversation, members, task binding and verification.
- Knowledge detail shows graph/source evidence, privacy/ownership, listing terms, preview/purchase/access/version and revocation state.
- Agent/org controls show effective policies, delegates and approval/budget state.
- Automation controls expose supported trigger semantics and run lifecycle honestly.
- Keep implementation internals out of normal user flows; present unresolved outcomes and approvals in plain language.

Reuse the existing shell, graph canvas and plan rendering where appropriate; use the relevant frontend design skills at implementation time. Do not build screens that only display seed/mock state for unimplemented services.

### P10 — Compile-only review and owner handoff

- Inspect package scripts and applicable Next.js bundled guidance before code changes.
- Use permitted TypeScript compilation/type checking and Rust compile checks for changed targets, with no test/smoke/runtime scripts. Do not run `desktop:dist`, which chains smoke programs and embeds upstream signing settings today.
- Do not deploy migrations or run Move localnet/test commands. Document contract compile requirements and request clarification if compilation itself needs a forbidden runtime.
- Record exact checks performed, unperformed runtime tests, dependency versions, migration ordering and service configuration names without secrets.
- Provide the owner a manual verification matrix: tenant isolation, purchases/entitlements, restarted runs, event replay, unknown transactions, duplicate AI calls, key rotation/revocation, graph privacy/exports, receipt checks, all MCP action/list scopes and responsive UI.
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
- [ ] R11 — Organization/delegate/approval/budget policy applies at tools, storage, context construction and events.
- [ ] R12 — No forbidden runtime/test/commit/push/deploy actions; compile results and unverified runtime cases documented.
- [ ] R13 — Existing user changes preserved; no fabricated Git remotes, service endpoints, deployed IDs or signing identities.
- [ ] R14 — Owner handoff includes migrations/configuration, action coverage manifest, source attribution and manual validation matrix.

For each checked requirement, completion notes must identify changed files and the actual evidence. Planned work, stubs, empty tool results and source inspection alone do not establish implemented functionality.

## 7. Sequencing and review boundaries

First reviewable milestone: approved decisions and contract/coverage manifest, safe branding, authenticated automation/task reads and existing task actions. Next: durable work execution and scoped rooms/AI. Next: private graph market and full work UI. Final: all remaining catalog actions/list gaps, compile-only cross-repo review and owner handoff.

These are intermediate delivery points, not definitions of success. The entire checklist remains the goal.

The multi-repository scope is larger than a few adapters. The 37 presently blocked catalog actions are a separate estimation driver from the harness and private-graph product. Re-estimate after mapping each resolver/builder/policy and confirming repository ownership; the earlier pilot estimate is not a commitment for complete platform coverage.
