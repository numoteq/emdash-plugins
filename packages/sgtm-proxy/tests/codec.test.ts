import { describe, expect, it } from "@effect/vitest";

import { base64url, decodeToken, derivePaths, encodeToken, fromBase64url } from "../src/codec.js";

const paths = derivePaths("GTM-NTQ37T97", "/k7", "");
const salt = Uint8Array.from([1, 2, 3, 4]);

describe("derivePaths", () => {
	it("derives stable, hash-only paths under the prefix", () => {
		expect(derivePaths("GTM-NTQ37T97", "/k7", "")).toEqual(paths);
		expect(paths.loaderPath).toMatch(/^\/k7\/[0-9a-z]+\.js$/);
		expect(paths.encodedPrefix).toMatch(/^\/k7\/[0-9a-z]+$/);
		expect(paths.loaderPath.slice(0, -3)).not.toBe(paths.encodedPrefix);
	});

	it("never puts the container id into a path", () => {
		for (const path of [paths.loaderPath, paths.encodedPrefix]) {
			expect(path.toLowerCase()).not.toContain("gtm");
			expect(path).not.toContain("NTQ37T97");
		}
	});

	it("changes every path with the container id and the salt", () => {
		for (const other of [
			derivePaths("GTM-ABCDEFG", "/k7", ""),
			derivePaths("GTM-NTQ37T97", "/k7", "x"),
		]) {
			expect(other.loaderPath).not.toBe(paths.loaderPath);
			expect(other.encodedPrefix).not.toBe(paths.encodedPrefix);
			expect(other.seed).not.toBe(paths.seed);
		}
	});
});

describe("base64url", () => {
	it("round-trips every length", () => {
		for (let length = 1; length < 10; length += 1) {
			const bytes = Uint8Array.from({ length }, (_, index) => (index * 97) & 255);
			expect(fromBase64url(base64url(bytes))).toEqual(bytes);
		}
	});

	it("rejects anything that is not base64url", () => {
		expect(fromBase64url("")).toBeNull();
		expect(fromBase64url("ab+c")).toBeNull();
		expect(fromBase64url("ab=c")).toBeNull();
	});
});

describe("token", () => {
	const hit = "/k7/g/collect?v=2&tid=G-WSNXXNBYV7&en=page_view";

	it("round-trips a path with its query", () => {
		expect(decodeToken(encodeToken(hit, salt, paths.seed), paths)).toBe(hit);
	});

	it("hides the original URL and differs with every salt", () => {
		const first = encodeToken(hit, salt, paths.seed);
		const second = encodeToken(hit, Uint8Array.from([4, 3, 2, 1]), paths.seed);
		expect(first).not.toBe(second);
		expect(first).not.toContain(base64url(new TextEncoder().encode("/g/collect")));
	});

	it("does not decode with another site's seed", () => {
		const other = derivePaths("GTM-ABCDEFG", "/k7", "");
		expect(decodeToken(encodeToken(hit, salt, paths.seed), other)).toBeNull();
	});

	it("refuses anything that is not a canonical path under the prefix", () => {
		for (const plain of [
			"/other/path",
			"/k7/../admin",
			"/k7/a\\b",
			"https://evil.example/k7/x",
			"//evil.example/k7/x",
			"/k7/a b",
		]) {
			expect({ plain, decoded: decodeToken(encodeToken(plain, salt, paths.seed), paths) }).toEqual({
				plain,
				decoded: null,
			});
		}
		expect(decodeToken("garbage!", paths)).toBeNull();
		expect(decodeToken("AAAA", paths)).toBeNull();
	});
});
