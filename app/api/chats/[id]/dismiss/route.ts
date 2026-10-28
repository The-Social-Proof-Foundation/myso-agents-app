/** Pending-question dismissal belongs to the retired teaching loop. */
export async function POST(_request: Request, _ctx: { params: Promise<{ id: string }> }) {
	return Response.json(
		{ error: "Legacy chat question dismissal is retired.", code: "legacy_chat_dismissal_retired" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
