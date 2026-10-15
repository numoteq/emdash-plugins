import { describe, expect, it } from "vitest";

import {
	base64url,
	decodeTarget,
	decodeToken,
	derivePaths,
	encodeToken,
	fromBase64url,
	mulberry32,
	normalizePrefix,
	xorKeystream,
} from "../src/codec.js";

const secret = "s3cret-per-site";
const salt = Uint8Array.from([1, 2, 3, 4]);

describe("normalizePrefix", () => {
	it("trims whitespace and a trailing slash", () => {
		expect(normalizePrefix("  /track/  ")).toBe("/track");
	});

	it("rejects anything that is not a plain single path", () => {
		for (const bad of ["k7", "", "  ", "/", "//k7", "/k7?a=1", "/k7#x", "/k7//x"]) {
			expect(() => normalizePrefix(bad)).toThrow(/prefix/);
		}
	});
});

describe("base64url", () => {
	it("round-trips every input length", () => {
		for (let length = 1; length <= 8; length += 1) {
			const bytes = Uint8Array.from({ length }, (_, index) => index * 31 + 7);
			expect(fromBase64url(base64url(bytes))).toEqual(bytes);
		}
	});

	it("encodes without padding and rejects foreign characters", () => {
		expect(base64url(Uint8Array.from([1, 2, 3, 4]))).toBe("AQIDBA");
		expect(base64url(Uint8Array.from([255]))).toBe("_w");
		expect(fromBase64url("AQID+")).toBeNull();
		expect(fromBase64url("AQID=")).toBeNull();
		expect(fromBase64url("")).toBeNull();
	});
});

describe("keystream", () => {
	it("stays on the frozen algorithm vector", () => {
		const next = mulberry32(1);
		expect([next(), next(), next(), next()]).toEqual([
			2693262067, 11749833, 2265367787, 4213581821,
		]);
		expect(Array.from(xorKeystream(new Uint8Array(4), 1))).toEqual([243, 234, 135, 160]);
	});

	it("is its own inverse for any length", () => {
		for (const data of [
			Uint8Array.from([]),
			Uint8Array.from([0]),
			Uint8Array.from([1, 2, 3]),
			Uint8Array.from([0, 1, 2, 250, 251, 252, 253]),
		]) {
			expect(xorKeystream(xorKeystream(data, 42), 42)).toEqual(data);
		}
	});
});

describe("derivePaths", () => {
	it("is deterministic for a secret and prefix", async () => {
		const first = await derivePaths({ secret, prefix: "/k7" });
		const second = await derivePaths({ secret, prefix: "/k7" });
		expect(second).toEqual(first);
	});

	it("derives every path from the prefix", async () => {
		const paths = await derivePaths({ secret, prefix: "/proxy" });
		expect(paths.prefix).toBe("/proxy");
		expect(paths.loaderPath).toMatch(/^\/proxy\/[0-9a-z]+\.js$/);
		expect(paths.encodedPrefix).toMatch(/^\/proxy\/[0-9a-z]+$/);
		expect(paths.loaderPath).not.toBe(`${paths.encodedPrefix}.js`);
		expect(paths.seed).toBeGreaterThanOrEqual(0);
		expect(paths.seed).toBeLessThan(2 ** 32);
	});

	it("changes every path when the secret rotates", async () => {
		const first = await derivePaths({ secret });
		const second = await derivePaths({ secret: "another-secret" });
		expect(first.prefix).toBe("/k7");
		expect(second.loaderPath).not.toBe(first.loaderPath);
		expect(second.encodedPrefix).not.toBe(first.encodedPrefix);
		expect(second.seed).not.toBe(first.seed);
	});

	it("rejects an empty secret", () => {
		expect(() => derivePaths({ secret: "" })).toThrow("secret");
	});
});

describe("request tokens", () => {
	it("round-trips a canonical path", () => {
		const token = encodeToken("/k7/td?id=G-X&v=2", salt, 12345);
		expect(decodeToken(token, 12345)).toBe("/k7/td?id=G-X&v=2");
		expect(decodeTarget(token, 12345, "/k7")).toBe("/k7/td?id=G-X&v=2");
	});

	it("needs the right seed", () => {
		const token = encodeToken("/k7/td", salt, 1);
		expect(decodeTarget(token, 2, "/k7")).not.toBe("/k7/td");
	});

	it("returns null for malformed tokens", () => {
		expect(decodeToken("", 1)).toBeNull();
		expect(decodeToken("AA", 1)).toBeNull();
		expect(decodeToken("!!!!!!!!", 1)).toBeNull();
		expect(decodeTarget("AA", 1, "/k7")).toBeNull();
	});

	it("uses a fresh salt per call, so tokens are not stable", () => {
		const first = encodeToken("/k7/td", Uint8Array.from([1, 2, 3, 4]), 7);
		const second = encodeToken("/k7/td", Uint8Array.from([5, 6, 7, 8]), 7);
		expect(second).not.toBe(first);
		expect(decodeToken(first, 7)).toBe(decodeToken(second, 7));
	});

	it("rejects a token whose plaintext escapes the prefix", () => {
		for (const plain of [
			"/other/x",
			"/k7",
			"/k7/../secret",
			"/k7/a/../../b",
			"/k7\\x",
			"https://evil.example/k7/x",
			"/k7/a b",
			"/k7/a#b",
		]) {
			expect(decodeTarget(encodeToken(plain, salt, 7), 7, "/k7")).toBeNull();
		}
	});

	it("keeps percent-encoded paths, which the shim sends as-is", () => {
		const token = encodeToken("/k7/a%20b?q=%C3%BD", salt, 7);
		expect(decodeTarget(token, 7, "/k7")).toBe("/k7/a%20b?q=%C3%BD");
	});
});
