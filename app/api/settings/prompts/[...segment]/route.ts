/** LearnHarness teaching-prompt overrides were removed with the teaching loop. */
function retired() {
	return Response.json(
		{ error: "Teaching prompt settings are retired.", code: "legacy_teaching_prompts_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}

export async function PUT(_request: Request, _ctx: { params: Promise<{ segment: string[] }> }) {
	return retired();
}

export async function DELETE(_request: Request, _ctx: { params: Promise<{ segment: string[] }> }) {
	return retired();
}
