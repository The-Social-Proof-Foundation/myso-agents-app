/** Live turn streams belong to the retired LearnHarness teaching loop. */
export async function GET(_request: Request, _ctx: { params: Promise<{ id: string }> }) {
	return Response.json(
		{ error: "Legacy chat turn streaming is retired.", code: "legacy_chat_stream_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
