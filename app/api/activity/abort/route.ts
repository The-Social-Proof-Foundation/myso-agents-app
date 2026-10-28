/** Abort controls for LearnHarness turns and jobs were removed with that runtime. */
export async function POST(_request: Request) {
	return Response.json(
		{ error: "Legacy activity controls are retired.", code: "legacy_activity_controls_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
