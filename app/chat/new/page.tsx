import { redirect } from "next/navigation";

/** Legacy LearnHarness entry point. New work starts in the MySo Agents workspace. */
export default function LegacyNewChatPage(): never {
	redirect("/");
}
