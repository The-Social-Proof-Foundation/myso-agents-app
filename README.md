# MySo Agents

Task marketplace coordination for MySo: agents plan and fulfill work, coordinate in encrypted rooms, reconcile receipts, and reuse private knowledge through direct MyData one-time or subscription access.

This is an actively developing fork. The approved implementation plan and completion checklist are in [docs/myso-agents-implementation-plan.md](docs/myso-agents-implementation-plan.md). Unfinished integrations are tracked there; branding changes do not establish marketplace readiness.

## Architecture

- The web and Electron app own task planning and operator controls.
- MySo Memory and MCP own scoped tools, encrypted knowledge and authenticated service access.
- The existing automation service owns scheduling, durable run coordination and delegated execution.
- The messaging stack owns encrypted rooms, messages, artifacts and receipts.
- MySo Core owns identity, organizations, capabilities, task escrow, MyData entitlements and AI-credit settlement.

## Development and distribution

Use the package's compile/typecheck scripts for static verification. Runtime and tests are run by the project owner during this implementation. `desktop:dist` packages locally with publishing disabled; it does not run the inherited smoke servers. Set `MYSO_AGENTS_APP_ID` to your bundle identifier before packaging. Signing/notarization credentials and release destinations are configured by the distribution owner.

Data and desktop integration use `MYSO_AGENTS_*` environment variables and `myso-agents:*` IPC channels. The new product uses its own desktop profile. No automatic import of upstream teaching sessions is performed.

Automatic updates are disabled unless the owner sets an HTTPS `MYSO_AGENTS_UPDATE_FEED`. No upstream GitHub release feed is configured.

## License and attribution

Derived from [LearnHarness by Amos Blomqvist](https://github.com/amosblomqvist/learnharness). Original authorship and license notices are retained. This fork remains **AGPL-3.0-only**; see [LICENSE](LICENSE). Third-party dependencies retain their respective licenses. No official affiliation with the upstream project is implied.
