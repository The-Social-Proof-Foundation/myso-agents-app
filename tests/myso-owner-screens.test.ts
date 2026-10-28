/**
 * Pure rules behind the remaining owner screens: post tip limit, room
 * bulk removal verification/summary, delivery size display.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCoin, formatDuration, formatMyso, parseMyso, tipAmountProblem } from "../components/myso-coin-format.ts";
import { bulkSummary, removalVerified, type BulkRoom } from "../components/myso-room-bulk-remove.tsx";
import { formatBytes } from "../components/myso-delivery-manifest.tsx";

describe("MYSO amounts", () => {
	it("parses decimal MYSO into exact MIST", () => {
		assert.equal(parseMyso("2.5"), "2500000000");
		assert.equal(parseMyso("0.000000001"), "1");
		assert.equal(parseMyso("3"), "3000000000");
		assert.equal(parseMyso("1.0000000001"), null, "more than 9 decimals");
		assert.equal(parseMyso("-1"), null);
		assert.equal(parseMyso("abc"), null);
	});
	it("formats MIST and other coins", () => {
		assert.equal(formatMyso("2500000000"), "2.5 MYSO");
		assert.equal(formatCoin("1000000000", "0x0000000000000000000000000000000000000000000000000000000000000002::myso::MYSO"), "1 MYSO");
		assert.equal(formatCoin("42", "0xabc::usdc::USDC"), "42 base units · USDC");
		assert.equal(formatDuration(String(30 * 86_400_000)), "30 days");
	});
});

describe("post tip limit (the per-action ceiling is the tip budget)", () => {
	it("refuses an amount above the live per-action limit", () => {
		assert.match(tipAmountProblem("6", "5000000000")!, /above the agent’s 5 MYSO per-action limit/);
	});
	it("accepts an amount at the limit, or any amount when unlimited", () => {
		assert.equal(tipAmountProblem("5", "5000000000"), null);
		assert.equal(tipAmountProblem("1000", "unlimited"), null);
	});
	it("refuses zero, empty and malformed amounts", () => {
		assert.ok(tipAmountProblem("0", "5000000000"));
		assert.ok(tipAmountProblem("", "5000000000"));
		assert.ok(tipAmountProblem("1.2.3", "5000000000"));
	});
});

describe("remove from every room", () => {
	const room: BulkRoom = { uuid: "u", groupId: "0x01", name: "Design review" };
	const ok = { groupId: "0x1", digest: "d", member: "0xAB", keyVersionBefore: "3", keyVersionAfter: "4", futureAccess: "revoked", pastAccess: "may_remain_available_or_previously_copied", verification: "finalized_membership_and_key_version", source: "myso_fullnode" } as const;
	it("accepts only a finalized removal of this member with a rotated key", () => {
		assert.equal(removalVerified(ok, room, "0xab"), true);
		assert.equal(removalVerified({ ...ok, keyVersionAfter: "3" }, room, "0xab"), false, "key must rotate");
		assert.equal(removalVerified({ ...ok, member: "0xcd" }, room, "0xab"), false, "different member");
		assert.equal(removalVerified({ ...ok, groupId: "0x2" }, room, "0xab"), false, "different room");
	});
	it("summarizes partial failure without hiding failed rooms", () => {
		assert.equal(bulkSummary({ a: { status: "removed", keyVersionAfter: "2", digest: "x" }, b: { status: "removed", keyVersionAfter: "5", digest: "y" } }), "Removed from all 2 rooms. Each room key was rotated.");
		assert.match(bulkSummary({ a: { status: "removed", keyVersionAfter: "2", digest: "x" }, b: { status: "failed", reason: "nope" } }), /Removed from 1 of 2 rooms\. 1 room failed/);
		assert.match(bulkSummary({ a: { status: "removed", keyVersionAfter: "2", digest: "x" }, b: { status: "removing" } }), /so far/);
	});
});

describe("delivery manifest sizes", () => {
	it("formats file sizes", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(48 * 1024), "48.0 KB");
		assert.equal(formatBytes(1.2 * 1024 * 1024), "1.2 MB");
	});
});
