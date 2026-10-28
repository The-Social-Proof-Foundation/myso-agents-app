import { redirect } from "next/navigation";

/** Legacy LearnHarness settings URL; the MySo Agents app opens at its workspace. */
export default function SettingsPage() { redirect("/"); }
