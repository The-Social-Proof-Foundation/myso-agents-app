/**
 * The legacy LearnHarness job endpoint is retired. Its former list operation
 * also recovered and respawned stranded teacher/prober jobs as a side effect.
 * MySo Agents work and automation use their own scoped durable-run APIs.
 */
export async function GET() {
	return Response.json(
		{
			error: "The LearnHarness job endpoint has been retired.",
			code: "legacy_jobs_endpoint_retired",
			workspace: "/",
		},
		{ status: 410 },
	);
}
