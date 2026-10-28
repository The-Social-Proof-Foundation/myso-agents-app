/** The former activity feed exposed LearnHarness jobs and extraction runs. */
export async function GET() {
	return Response.json(
		{ error: "Legacy activity is retired.", code: "legacy_activity_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
