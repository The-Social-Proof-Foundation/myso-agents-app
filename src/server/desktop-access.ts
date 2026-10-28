import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Hosted work uses its own verified OAuth scope. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.MYSO_AGENTS_DESKTOP_API_SECRET;
	if (env.MYSO_AGENTS_DESKTOP_SERVER !== "1" && !expected) return false;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-myso-agents-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
