import { describe, expect, it } from "@effect/vitest";

import { decodeToken, encodeToken } from "../src/codec.js";
import { encodedPrefix, sgtmLoaderPath } from "../src/paths.js";

const salt = Uint8Array.from([1, 2, 3, 4]);

describe("paths", () => {
	it("derive stable, distinct paths from the host", () => {
		expect(sgtmLoaderPath("www.site.example")).toBe(sgtmLoaderPath("WWW.Site.Example"));
		expect(sgtmLoaderPath("www.site.example")).toMatch(/^\/[0-9a-z]+\.js$/);
		expect(encodedPrefix("www.site.example")).toBe(
			`${sgtmLoaderPath("www.site.example").slice(0, -3)}/`,
		);
		expect(sgtmLoaderPath("www.other.example")).not.toBe(sgtmLoaderPath("www.site.example"));
	});

	it("never share a prefix across www hosts", () => {
		const prefixes = ["www.a.example", "www.b.example", "www.c.example"].map((host) =>
			sgtmLoaderPath(host).slice(0, 3),
		);
		expect(new Set(prefixes).size).toBe(3);
	});
});

describe("token", () => {
	const hit = "/g/collect?v=2&tid=G-WSNXXNBYV7&en=page_view";

	it("round-trips a path with its query", () => {
		expect(decodeToken(encodeToken(hit, salt))).toBe(hit);
	});

	it("hides the original URL and differs with every salt", () => {
		const first = encodeToken(hit, salt);
		const second = encodeToken(hit, Uint8Array.from([4, 3, 2, 1]));
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first).not.toContain(btoa("/g/collect").slice(0, 8));
	});

	it("refuses anything that is not a canonical path under the prefix", () => {
		for (const plain of [
			"/../admin",
			"/a\\b",
			"/a b",
			"x",
			"",
			"/%2e%2e/admin/../x",
			"//evil.example/x",
		]) {
			expect({ plain, decoded: decodeToken(encodeToken(plain, salt)) }).toEqual({
				plain,
				decoded: null,
			});
		}
		expect(decodeToken("garbage!")).toBeNull();
		expect(decodeToken("AAAA")).toBeNull();
		expect(decodeToken("A")).toBeNull();
	});
});
