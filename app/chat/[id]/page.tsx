import { redirect } from "next/navigation";

/** Legacy LearnHarness chat links now open the MySo Agents workspace. */
export default function LegacyChatPage(): never {
	redirect("/");
}
