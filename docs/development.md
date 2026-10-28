# MySo Agents development guide

MySo Agents is the web and Electron workbench for MySo task-market coordination. It plans and journals work, connects authenticated MCP capabilities, reads task and receipt state, and coordinates rooms, automations and private knowledge through the existing MySo services. The task coordinator is the primary harness; the upstream teaching loop is not the product workflow.

The approved scope, source baseline and acceptance checklist live in [the implementation plan](myso-agents-implementation-plan.md). Current implementation and remaining gaps are tracked in [implementation status](myso-agents-implementation-status.md). Treat that checklist as open until every item has source and compile evidence plus owner-run validation where required.

For the testnet demo setup and owner-run acceptance sequence, use the [MySo Agents end-to-end MVP runbook](myso-agents-mvp-runbook.md). The runbook is a guide; it does not claim that services, migrations or contracts have been started or deployed.

## Source boundaries

- `app/` and `components/` contain the web application and workspace UI.
- `src/agent/` owns the MySo work coordinator and model adapter.
- `src/core/` contains typed task, work-plan, receipt and knowledge contracts.
- `src/server/` owns authenticated routes and service adapters.
- `electron/` is a thin desktop shell; the standalone Next.js server owns application behavior.
- MySo Memory/MCP owns scoped tools, encrypted work journals and private-data access; MySo Core owns chain contracts, identity, organizations, task escrow and AI-credit settlement; the messaging stack owns encrypted rooms and message operations; the existing automation service owns durable scheduled jobs.

Do not introduce a second scheduler, private signing key store, or authority source in the app. Re-read current authorization and task state at the service boundary. Indexer data is a preview; it is not proof of current identity, permission, settlement or chain state.

## Static checks

Install dependencies before using the package scripts. `npm run typecheck` and `npm run desktop:compile` perform TypeScript compilation without starting the app. The owner runs tests, application servers, browser sessions, Electron runtimes and service integrations.

`npm run dev`, `npm run desktop:dev`, `npm run start`, `npm run desktop:dist`, and `npm run build` start or package application processes; use them only when the owner requests runtime or packaging work. Do not submit transactions, publish releases, deploy contracts or apply database migrations as part of local source implementation.

## Web and desktop identity

The package slug is `myso-agents`, the displayed product name is **MySo Agents**, the desktop bundle ID is `com.mysocial.agents`, and the product/help URL is `https://mysocial.network/agents`. A separate desktop profile prevents automatic reuse of upstream LearnHarness data or credentials.

The Electron shell exposes narrowly scoped `myso-agents:*` channels. Hosted sign-in uses public PKCE and encrypted HttpOnly cookies; desktop sign-in completes in the system browser and returns a one-time encrypted session grant over the private main-process channel. Do not add renderer access to signing keys, arbitrary IPC, local filesystem tools or provider-key reflection.

## Release configuration

The desktop updater and release publishing remain disabled until the owner supplies real feed/repository and signing infrastructure. `MYSO_AGENTS_UPDATE_FEED` must remain unset for unsigned development builds. The supplied stable-feed URL and GitHub release repository are placeholders, not active destinations. See [desktop release configuration](desktop-release.md) before changing packaging.

The Jury voting UI uses the authenticated MCP read `jury_get_case_bundle`. Configure Memory with `JURY_BUNDLE_RUNNER_URL` and `JURY_BUNDLE_READ_TOKEN`, and configure the runner with the same secret as `BUNDLE_READ_TOKEN`; the shared server-side token must be at least 32 characters. Memory checks the caller's assignment and case/round before proxying the request. Hosted and local MCP verify the canonical bundle digest, and the app verifies it again before preparing a ballot. This capability remains unavailable when Memory or the runner is unconfigured.

The fork remains AGPL-3.0-only and retains upstream copyright and attribution. MySocial trademarks and brand assets do not transfer trademark rights; consult the relevant notices before redistribution.
