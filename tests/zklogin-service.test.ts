import assert from "node:assert/strict";
import test from "node:test";
import { zkLoginProveUrl, zkLoginProverNetwork, zkLoginSaltOrigin } from "../src/server/zklogin-service.ts";

test("salt origin drops a trailing /salt path", () => {
    const previousPublic = process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL;
    const previousApi = process.env.MYSOCIAL_SALT_API_URL;
    process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL = "https://salt.testnet.mysocial.network/salt/";
    delete process.env.MYSOCIAL_SALT_API_URL;
    assert.equal(zkLoginSaltOrigin(), "https://salt.testnet.mysocial.network");
    if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL;
    else process.env.NEXT_PUBLIC_MYSOCIAL_SALT_URL = previousPublic;
    if (previousApi === undefined) delete process.env.MYSOCIAL_SALT_API_URL;
    else process.env.MYSOCIAL_SALT_API_URL = previousApi;
});

test("prove URL accepts an origin or a /prove path", () => {
    const previous = process.env.MYSO_ZKLOGIN_PROVER_URL;
    const previousFallback = process.env.ZKLOGIN_PROVER_URL;
    delete process.env.ZKLOGIN_PROVER_URL;
    process.env.MYSO_ZKLOGIN_PROVER_URL = "https://zklogin-testnet.mysocial.network";
    assert.equal(zkLoginProveUrl(), "https://zklogin-testnet.mysocial.network/prove");
    process.env.MYSO_ZKLOGIN_PROVER_URL = "https://zklogin-testnet.mysocial.network/prove/";
    assert.equal(zkLoginProveUrl(), "https://zklogin-testnet.mysocial.network/prove");
    delete process.env.MYSO_ZKLOGIN_PROVER_URL;
    assert.equal(zkLoginProveUrl(), null);
    if (previous === undefined) delete process.env.MYSO_ZKLOGIN_PROVER_URL;
    else process.env.MYSO_ZKLOGIN_PROVER_URL = previous;
    if (previousFallback === undefined) delete process.env.ZKLOGIN_PROVER_URL;
    else process.env.ZKLOGIN_PROVER_URL = previousFallback;
});

test("localnet prover requests are sent as testnet", () => {
    const previous = process.env.ZKLOGIN_PROVER_NETWORK;
    process.env.ZKLOGIN_PROVER_NETWORK = "localnet";
    assert.equal(zkLoginProverNetwork("mainnet"), "testnet");
    process.env.ZKLOGIN_PROVER_NETWORK = "mainnet";
    assert.equal(zkLoginProverNetwork(), "mainnet");
    if (previous === undefined) delete process.env.ZKLOGIN_PROVER_NETWORK;
    else process.env.ZKLOGIN_PROVER_NETWORK = previous;
});
