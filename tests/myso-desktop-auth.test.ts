/** Owner-run credential-boundary regressions. These tests do not launch Electron. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createMySoDesktopConnection } = require("../electron/myso-auth.cjs");
const secret = "ab".repeat(32);
const ticket = "a".repeat(43);
const grant = { value: "b".repeat(60), expiresAt: Date.now() + 600000, custodyAccessToken: "c".repeat(40) };

test("main receives the session grant; renderer gets only connection status", async () => {
    let installed: unknown;
    const requests: string[] = [];
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async (url: string) => { assert.equal(new URL(url).origin, "https://identity.example"); },
        installSession: async (value: unknown) => { installed = value; },
        clearSession: async () => { throw new Error("must not clear a successful session"); },
        fetchImpl: async (url: URL, init: RequestInit) => {
            requests.push(url.pathname);
            assert.equal((init.headers as Record<string,string>)["x-myso-agents-handoff"], secret);
            assert.equal((init.headers as Record<string,string>)["x-myso-agents-desktop"], undefined);
            return Response.json(url.pathname.endsWith("/start") ? { ticket, expiresAt: Date.now() + 600000, authorizationUrl: "https://identity.example/authorize?state=opaque" }
                : url.pathname.endsWith("/result") ? { status: "ready", grant } : { cancelled: true });
        },
    });
    assert.deepEqual(await connection.connect(), { connected: true, custodyAccessToken: grant.custodyAccessToken });
    assert.deepEqual(installed, grant);
    assert.equal(JSON.stringify(installed).includes("refreshToken"), false);
    assert.ok(requests.some(path => path.endsWith("/cancel")));
});

test("cancel during cookie installation compensates only the candidate session", async () => {
    const cleared: string[] = [];
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => {},
        installSession: async () => { await connection.cancel(); },
        clearSession: async (value: string) => { cleared.push(value); },
        fetchImpl: async (url: URL) => Response.json(url.pathname.endsWith("/start") ? { ticket, expiresAt: Date.now() + 600000, authorizationUrl: "https://identity.example/authorize" }
            : url.pathname.endsWith("/result") ? { status: "ready", grant } : { cancelled: true }),
    });
    const result = await connection.connect();
    assert.equal(result.connected, false);
    assert.equal(result.cancelled, true);
    assert.deepEqual(cleared, [grant.value]);
    assert.equal(JSON.stringify(result).includes(grant.value), false);
});

test("an invalid external authorization URL cannot reach the system browser", async () => {
    let opened = false;
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => { opened = true; }, installSession: async () => {}, clearSession: async () => {},
        fetchImpl: async (url: URL) => Response.json(url.pathname.endsWith("/start") ? { ticket, expiresAt: Date.now() + 600000, authorizationUrl: "file:///private/secret" } : { cancelled: true }),
    });
    assert.equal((await connection.connect()).connected, false);
    assert.equal(opened, false);
});

test("a refresh token stays in main and is absent from the renderer result", async () => {
    const refreshToken = "d".repeat(43);
    let persisted: { token?: string; expiresAt?: number } = {};
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => {},
        installSession: async (value: { refreshToken?: string }) => { assert.equal(value.refreshToken, undefined); },
        clearSession: async () => { throw new Error("must not clear a successful session"); },
        persistRefresh: (token: string, expiresAt: number) => { persisted = { token, expiresAt }; },
        fetchImpl: async (url: URL) => Response.json(url.pathname.endsWith("/start")
            ? { ticket, expiresAt: Date.now() + 600000, authorizationUrl: "https://identity.example/authorize" }
            : url.pathname.endsWith("/result") ? { status: "ready", grant: { ...grant, refreshToken } } : { cancelled: true }),
    });
    const result = await connection.connect();
    assert.equal(result.connected, true);
    assert.equal(JSON.stringify(result).includes(refreshToken), false);
    assert.equal(persisted.token, refreshToken);
    assert.equal(persisted.expiresAt, grant.expiresAt);
});

test("renewal installs the new cookie before replacing the refresh token", async () => {
    const previous = "e".repeat(43);
    const rotated = "f".repeat(43);
    const installed: string[] = [];
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => {},
        installSession: async (value: { value: string }) => { installed.push(value.value); },
        clearSession: async () => {},
        fetchImpl: async () => Response.json({ grant: { ...grant, value: "g".repeat(60) }, refreshToken: rotated }),
    });
    const renewed = await connection.renew(previous);
    assert.equal(renewed.status, "refreshed");
    assert.equal(renewed.refreshToken, rotated);
    assert.deepEqual(installed, ["g".repeat(60)]);
    assert.equal(JSON.stringify(renewed).includes(previous), false);
});

test("a rejected refresh does not install a session", async () => {
    let installed = false;
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => {},
        installSession: async () => { installed = true; },
        clearSession: async () => {},
        fetchImpl: async () => Response.json({ error: "Reconnect your MySo account" }, { status: 401 }),
    });
    assert.deepEqual(await connection.renew("h".repeat(43)), { status: "revoked" });
    assert.equal(installed, false);
});

test("a busy refresh keeps the current token", async () => {
    let installed = false;
    const connection = createMySoDesktopConnection({
        origin: "http://127.0.0.1:3000", secret,
        openExternal: async () => {},
        installSession: async () => { installed = true; },
        clearSession: async () => {},
        fetchImpl: async () => Response.json({ error: "busy" }, { status: 429 }),
    });
    assert.deepEqual(await connection.renew("i".repeat(43)), { status: "retry" });
    assert.equal(installed, false);
});
