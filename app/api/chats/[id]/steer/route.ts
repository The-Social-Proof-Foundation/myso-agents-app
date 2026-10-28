/** Mid-turn steering belongs to the retired LearnHarness teaching loop. */
export async function POST(_request: Request, _ctx: { params: Promise<{ id: string }> }) {
	return Response.json(
		{ error: "Legacy chat steering is retired.", code: "legacy_chat_steering_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
