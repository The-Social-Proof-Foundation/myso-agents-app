/**
 * start-standalone.mjs — local production server.
 *
 * `output: "standalone"` makes `next start` refuse to boot. The Electron
 * shell and smoke-server.mjs already spawn `.next/standalone/server.js`.
 * This does the same for `pnpm start`, after build-server.mjs copies
 * public/ and .next/static into the standalone payload.
 *
 * Port: `pnpm start -p 3005` or `PORT=3005 pnpm start`. The server reads PORT.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function loadProjectEnv(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

function portFromArgs(argv) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--port") return argv[i + 1];
		if (arg.startsWith("--port=")) return arg.slice("--port=".length);
	}
	return undefined;
}

const port = portFromArgs(process.argv.slice(2));
if (port !== undefined) {
	if (!/^\d+$/.test(port)) {
		console.error(`[start] invalid port: ${port}`);
		process.exit(1);
	}
	process.env.PORT = port;
}

loadProjectEnv(path.join(root, ".env"));
loadProjectEnv(path.join(root, ".env.local"));

// Next copies a loaded project .env into the standalone folder after tracing.
// Local start reads that file itself. The copy must not remain in the payload.
for (const secret of [".env", ".env.local", "auth.json"]) {
	const copied = path.join(root, ".next", "standalone", secret);
	if (fs.existsSync(copied)) fs.rmSync(copied);
}

const listenPort = process.env.PORT || "3000";
if (!process.env.MYSO_AGENTS_PUBLIC_ORIGIN) {
	process.env.MYSO_AGENTS_PUBLIC_ORIGIN = `http://localhost:${listenPort}`;
}
if (!process.env.MYSO_AGENTS_SESSION_KEY) {
	const keyFile = path.join(root, ".myso-agents-session-key");
	let key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
	if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) {
		key = randomBytes(32).toString("base64");
		fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
	}
	process.env.MYSO_AGENTS_SESSION_KEY = key;
}

function run(file) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file], {
			cwd: root,
			stdio: "inherit",
			env: process.env,
		});
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

const prepCode = await run(path.join(root, "scripts", "build-server.mjs"));
if (prepCode !== 0) process.exit(prepCode);

const server = spawn(process.execPath, [path.join(root, ".next", "standalone", "server.js")], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.kill(signal));
}

server.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
