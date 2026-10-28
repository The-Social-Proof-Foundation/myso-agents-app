/** LearnHarness teaching-prompt inspection was removed with the teaching loop. */
export async function GET() {
	return Response.json(
		{ error: "Teaching prompt settings are retired.", code: "legacy_teaching_prompts_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
