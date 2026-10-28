# MySo Agents

Task marketplace coordination for MySo: agents plan and fulfill work, coordinate in encrypted rooms, reconcile receipts, and reuse private knowledge through direct MyData one-time or subscription access.

This is an actively developing fork. The approved implementation plan and completion checklist are in [docs/myso-agents-implementation-plan.md](docs/myso-agents-implementation-plan.md). The current changes and remaining gaps are tracked in [docs/myso-agents-implementation-status.md](docs/myso-agents-implementation-status.md). This is not a finished marketplace release.

The owner-facing setup and acceptance sequence for the first testnet end-to-end demo is [docs/myso-agents-mvp-runbook.md](docs/myso-agents-mvp-runbook.md). It covers the named-seller task, encrypted room, R2 delivery, settlement, private graph access and Automation path, and marks deployment/runtime gates that source compilation cannot establish.

## Architecture

- The web and Electron app own task planning and operator controls.
- MySo Memory and MCP own scoped tools, encrypted knowledge and authenticated service access.
- The existing automation service owns background scheduling and delegated jobs. A durable encrypted foreground run journal now lives in the memory service; background harness dispatch is still being integrated.
- The messaging stack owns encrypted rooms, messages, artifacts and receipts.
- MySo Core owns identity, organizations, capabilities, task escrow, MyData entitlements and AI-credit settlement.

## Current product path

The homepage uses MySocial’s existing brand and local font/logo assets. It reads authenticated work runs, owned market tasks, room metadata, indexed receipts and automations. New work runs use the task coordinator and signed MySo AI-credit adapter; no quiz or lesson is required.

Run plans and operation results are MYDATA-encrypted in the memory service. Model and action identities are recorded before dispatch. Foreground turns use renewable fences and awaited transcript checkpoints. An uncertain payment/model outcome or abandoned turn is held for reconciliation rather than automatically repeated.

Named direct MyData quotes, bounded one-time/recurring purchases, and scoped purchase-event reads are implemented in the MCP/server/contract sources. Verified GraphManifest offers now have an explicit owner-wallet checkout in web and desktop: it rechecks the seller proof, exact quote and owner-held MYSO coin, requests approval for the exact purchase, collects owner message and transaction signatures, and checks the finalized receipt. For an agent audience, checkout then requests a separate owner-approved grant to the authenticated agent address and verifies that grant; subscription grants are capped to the remaining purchased period. Organization audiences are checked against the chain-bound organization event. Automatic agent purchases follow live on-chain capability, approval policy and per-action spending limits; the app adds no seller allowlist or spending cap. Purchases stay disabled until the changed contract is deployed and the memory server explicitly enables them. Configure OAuth `social:write`, `social:approve`, `payments:read`, and `mydata:share` for owner checkout; `NEXT_PUBLIC_MYSO_WALLETCONNECT_PROJECT_ID` enables WalletConnect discovery while injected MySo Wallet Standard wallets work without it.

Series-wide subscription history, encrypted room conversation coverage, verified task-step/artifact projection, full recovery, gas/transfer budgets and source-level parity for remaining MCP reads are unfinished. Typed graph publication, verified P2P purchase, per-page key release, and consented interactive/unattended graph reads are implemented in source but remain subject to deployment and owner runtime validation. Room metadata alone is not an encrypted room integration. The oracle’s independent completion ledger still needs private-content protection.

Configure the actual endpoints and OAuth registration using [.env.example](.env.example). The hosted client uses public PKCE, encrypted HttpOnly cookies and live MCP identity checks. Desktop sign-in opens the system browser and delivers a single-use encrypted session grant directly to Electron main over a separate private channel. Preload exposes connect/cancel only. The source path is compiled but still needs owner-run sign-in and cancellation testing. Legacy local APIs are disabled by default. The new transport never imports their global filesystem stores or provider-key reflection.

## Development and distribution

`desktop:dev` starts an owned loopback web server and Electron with distinct per-launch request and sign-in capabilities; it replaces the inherited uncoordinated development pair. Register the exact development loopback origin (default port 3000, configurable with `PORT`) and the packaged loopback redirect policy with your OAuth issuer. An arbitrary externally launched development server does not receive the private sign-in bridge. Reconnect after restart or token expiry; refresh-token renewal is not implemented.

Use the package's compile/typecheck scripts for static verification. Runtime and tests are run by the project owner during this implementation. `desktop:dist` packages locally with publishing disabled; it does not run the inherited smoke servers. The bundle identifier is `com.mysocial.agents`. Unsigned/ad-hoc development builds only; keep updates disabled until real signing and feed infrastructure are configured.

Data and desktop integration use `MYSO_AGENTS_*` environment variables and `myso-agents:*` IPC channels. The new product uses its own desktop profile. No automatic import of upstream teaching sessions is performed.

Automatic updates are disabled unless the owner sets an HTTPS `MYSO_AGENTS_UPDATE_FEED`. No upstream GitHub release feed is configured.

## License and attribution

Derived from [LearnHarness by Amos Blomqvist](https://github.com/amosblomqvist/learnharness). Original authorship and license notices are retained. This fork remains **AGPL-3.0-only**; see [LICENSE](LICENSE). Third-party dependencies retain their respective licenses. No official affiliation with the upstream project is implied.

## Direct private-data reader

Knowledge inspects a named MyData P2P listing and reads a bounded text/base64
page using the connected agent's current access. Prices remain exact decimal
MIST; seller, access period, version and ciphertext fingerprint are shown before
reading. Content stays in temporary view state and clears on navigation,
page hide or window backgrounding. It is rendered as escaped text, outside work
journals and AI inference. The server revalidates returned identity and pages.

The feature requires `mydata:read` / `mydata:decrypt`, a caller-bound session
adapter in the hosted MCP, and explicit memory-server
`MYDATA_LISTING_ACCESS_ENABLED=true` after the updated native policy and sidecar
are deployed and verified. Purchases use the independent bounded-purchase flag
and `mydata:purchase`. Neither flag is enabled by this source change.

The private reader can search already-published `myso.knowledge-graph.v1`
records and display linked evidence/provenance. Graph authoring/publication,
discovery/version history, entitlement lifecycle/revocation views, derived
content rights and private-inference retention remain open. Work coordinators
can invoke typed graph search/item reads only after explicit per-run consent,
including durable automation runs; raw `mydata_read_content` remains excluded.
Provider retention and deployment-level key-release behavior still require
validation. No running UI or key release was tested here.
