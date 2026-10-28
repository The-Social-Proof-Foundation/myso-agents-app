/**
 * The LearnHarness turn endpoint is retired. Normal work now enters through
 * the MySo Agents run API, which binds execution to an authenticated agent,
 * task scope, policy and durable run record. Keeping the old handler reachable
 * would allow callers to start the removed teacher/prober loop directly.
 */
export async function POST(_req: Request) {
	return Response.json(
		{
			error: "The LearnHarness chat endpoint has been retired.",
			code: "legacy_chat_endpoint_retired",
			workspace: "/",
		},
		{ status: 410 },
	);
}
