import { describe, expect, it } from "@effect/vitest";

import { decodeToken, encodeToken } from "../src/codec.js";
import { encodedPrefix, loaderPath } from "../src/paths.js";

const salt = Uint8Array.from([1, 2, 3, 4]);

describe("paths", () => {
	it("derive stable, distinct paths from the host", () => {
		expect(loaderPath("www.site.example")).toBe(loaderPath("WWW.Site.Example"));
		expect(loaderPath("www.site.example")).toMatch(/^\/[0-9a-z]+\.js$/);
		expect(encodedPrefix("www.other.example")).not.toBe(encodedPrefix("www.site.example"));
	});

	it("share the loader hash between the loader and the encoded prefix", () => {
		const hash = loaderPath("www.site.example").slice(0, -3);
		expect(encodedPrefix("www.site.example")).toBe(`${hash}/`);
		expect(encodedPrefix("www.site.example")).toMatch(/^\/[0-9a-z]+\/$/);
	});

	it("never share a prefix across www hosts", () => {
		const prefixes = ["www.a.example", "www.b.example", "www.c.example"].map((host) =>
			loaderPath(host).slice(0, 3),
		);
		expect(new Set(prefixes).size).toBe(3);
	});
});

describe("token", () => {
	const hits = ["/_sgtm/g/collect?v=2", "/_op/track"];

	it("round-trips a full internal path with its query", () => {
		for (const hit of hits) {
			expect(decodeToken(encodeToken(hit, salt))).toBe(hit);
		}
		expect(decodeToken(encodeToken("/_sgtm/g/collect?v=2&en=page_view", salt))).toBe(
			"/_sgtm/g/collect?v=2&en=page_view",
		);
	});

	it("hides the original URL and differs with every salt", () => {
		const first = encodeToken("/_sgtm/g/collect?v=2", salt);
		const second = encodeToken("/_sgtm/g/collect?v=2", Uint8Array.from([4, 3, 2, 1]));
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first).not.toContain("/");
		expect(first).not.toContain("collect");
	});

	it("refuses anything that is not a canonical path", () => {
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
