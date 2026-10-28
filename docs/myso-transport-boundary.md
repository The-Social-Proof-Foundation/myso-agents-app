# Scoped transport boundary

The new `app/api/myso/**` routes import only `src/server/myso.ts`. This barrel exports the authenticated MySo handlers and excludes the legacy server barrel’s filesystem store composition, environment key reflection and process-wide event channel. ESLint’s transport exception names this separate entry point explicitly.

`src/agent/coordinator-agent.ts` receives a scoped durable store, authenticated MCP port, model engine and tool policy through its factory. It imports the small product identity module and a task-specific requirements question tool. It does not load the teaching agent, legacy local file tools or provider catalogs. Every tool batch is sequential; an owner question or failed/uncertain operation blocks later calls in that batch.

The normal homepage mounts only the scoped workspace. The legacy API, chat and settings routes remain disabled unless `MYSO_AGENTS_ENABLE_LEGACY_LOCAL_API=1` is explicitly configured and the request has the trusted desktop capability. That compatibility switch is not a hosted authentication mechanism and should not be enabled for hosted deployments.

All ordinary work APIs verify the token against the configured MCP resource and then read the live account/agent context. A requested run ID or plan assignment does not establish execution authority. The memory service stamps scope and uses its own authenticated identity for storage and service calls.

The run journal owns encrypted records; the automation service remains the background scheduler. Fences/holds are implemented; full verified recovery and async background harness dispatch are still open work.

Desktop authentication uses two distinct process capabilities. The ordinary renderer API capability is added only to trusted main-frame requests to the owned API origin. The handoff capability is carried only by Electron main to `/api/myso/auth/desktop/**`; it is never injected into renderer requests. A bounded ephemeral PKCE flow maps the system-browser callback to a one-time encrypted cookie grant, which main installs as HttpOnly. Cookie-authenticated desktop work requests additionally require the renderer capability. Cancellation, expiry and callback replay cannot release another grant. These source invariants still require owner-run behavior tests.

The `scripts/desktop-dev.mjs` launcher supplies these same private channels to the development pair. It does not pass secrets in command arguments. Packaged loopback ports are allocated per launch; encrypted cookies bind to the origin, so a persistent encryption key alone does not preserve a session across a port change.
