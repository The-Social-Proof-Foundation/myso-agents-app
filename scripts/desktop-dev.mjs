/** Owned development pair. Secrets are generated once and passed through child
 * environments, never command arguments, stdout, or renderer JavaScript. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.PORT ?? "3000";
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("PORT must be an unprivileged TCP port from 1024 to 65535");
const origin = `http://127.0.0.1:${Number(port)}`;
const env = {
    ...process.env,
    MYSO_AGENTS_DEV_URL: origin,
    MYSO_AGENTS_PUBLIC_ORIGIN: origin,
    MYSO_AGENTS_DESKTOP_SERVER: "1",
    MYSO_AGENTS_DESKTOP_API_SECRET: randomBytes(32).toString("hex"),
    MYSO_AGENTS_DESKTOP_HANDOFF_SECRET: randomBytes(32).toString("hex"),
    MYSO_AGENTS_SESSION_KEY: process.env.MYSO_AGENTS_SESSION_KEY || randomBytes(32).toString("base64"),
};
const next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(Number(port))], { cwd: root, env, stdio: "inherit" });
let electron;
let stopping = false;
function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    next.kill();
    electron?.kill();
    // Do not leave a child alive after an interrupted development session.
    const timer = setTimeout(() => { next.kill("SIGKILL"); electron?.kill("SIGKILL"); }, 5000);
    timer.unref();
}
process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
next.once("error", () => { console.error("Could not start the MySo Agents development server"); stop(1); });
next.once("exit", (code) => stop(stopping ? process.exitCode ?? 0 : code ?? 1));
try {
    const deadline = Date.now() + 120000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
        try {
            const response = await fetch(origin, { redirect: "error", signal: AbortSignal.timeout(1000) });
            ready = response.ok;
            await response.body?.cancel();
            if (ready) break;
        } catch { /* Next can still be compiling its first page. */ }
        await delay(500);
    }
    if (!stopping && !ready) throw new Error("The MySo Agents development server did not become ready");
    if (!stopping) {
        // Resolve Electron's executable with the launcher's Node process. No shell or secret argv.
        const executable = require("electron");
        electron = spawn(executable, ["."], { cwd: root, env, stdio: "inherit" });
        electron.once("error", () => { console.error("Could not start the MySo Agents desktop shell"); stop(1); });
        electron.once("exit", (code) => stop(stopping ? process.exitCode ?? 0 : code ?? 1));
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : "Desktop development startup failed");
    stop(1);
}
