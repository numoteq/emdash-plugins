import { describe, expect, it } from "vitest";

import fixtureSource from "./fixtures/gtm-excerpt.js.txt?raw";

import { DEFAULT_COOKIE_ALLOW } from "../src/codec.js";
import {
	buildUpstreamHeaders,
	concatBytes,
	filterCookies,
	getSetCookies,
	indexOfBytes,
	isJavaScript,
	rebuildResponse,
	replaceBytes,
	rewriteGtmHosts,
} from "../src/rewrite.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const site = { origin: "https://site.example", host: "site.example", prefix: "/k7" };

function fixture(): string {
	return fixtureSource;
}

function rewrite(text: string, target = site): string {
	return decoder.decode(rewriteGtmHosts(encoder.encode(text), target));
}

describe("rewriteGtmHosts", () => {
	it("replaces every container host in a real gtm.js excerpt", () => {
		const source = fixture();
		// Two in the container blob, two in the service-worker code, one in the iframe check,
		// one protocol-relative lookalike and one in the header comment above.
		expect(source.match(/www\.googletagmanager\.com/g)).toHaveLength(7);

		const output = rewrite(source);

		expect(output).not.toContain("www.googletagmanager.com");
		expect(output).not.toContain("https://www.googletagmanager.com");
		expect(output).toContain('"21":"site.example/k7"');
		expect(output).toContain('"3":"site.example/k7"');
		expect(output).toContain('ac(Vc,"https://site.example/k7/")');
		expect(output).toContain('a="https://site.example/k7/static/service_worker/"');
		expect(output).toContain('a.origin!=="https://site.example/k7"');
		expect(output).toContain('"//site.example/k7/x"');
	});

	it("keeps the container's own escaped-dot hostname regex", () => {
		expect(rewrite(fixture())).toContain("/(^|\\.)googletagmanager\\.com$/.test(b)");
	});

	it("leaves third-party endpoints untouched", () => {
		const output = rewrite(fixture());
		for (const endpoint of [
			"https://stats.g.doubleclick.net/g/collect",
			"https://adservice.google.com/pagead/regclk",
			"https://www.facebook.com/tr/",
			"https://pagead2.googlesyndication.com/pagead/gen_204?id=tcfe",
			"https://cct.google/taggy/agent.js",
			"https://www.google-analytics.com/g/collect",
			"https://tagassistant.google.com/",
			"google.tagmanager.debugui2.queue",
		]) {
			expect(output).toContain(endpoint);
		}
	});

	it("keeps the port in the bare host rewrite", () => {
		const output = rewrite('"21":"www.googletagmanager.com"', {
			origin: "http://localhost:8788",
			host: "localhost:8788",
			prefix: "/k7",
		});
		expect(output).toBe('"21":"localhost:8788/k7"');
	});

	it("works on bytes, so non-UTF-8 data survives", () => {
		const source = concatBytes([
			encoder.encode("a"),
			Uint8Array.from([0xff, 0xfe]),
			encoder.encode("https://www.googletagmanager.com/x"),
		]);

		const output = rewriteGtmHosts(source, site);

		expect(Array.from(output.subarray(1, 3))).toEqual([0xff, 0xfe]);
		expect(decoder.decode(output.subarray(3))).toBe("https://site.example/k7/x");
	});
});

describe("replaceBytes", () => {
	it("replaces every occurrence", () => {
		const output = replaceBytes(
			encoder.encode("a-b-a-b"),
			encoder.encode("a"),
			encoder.encode("X"),
		);
		expect(decoder.decode(output)).toBe("X-b-X-b");
	});

	it("returns the input when nothing matches", () => {
		const input = encoder.encode("abc");
		expect(replaceBytes(input, encoder.encode("z"), encoder.encode("y"))).toBe(input);
	});

	it("locates needles from an offset", () => {
		const haystack = encoder.encode("aXbX");
		expect(indexOfBytes(haystack, encoder.encode("X"))).toBe(1);
		expect(indexOfBytes(haystack, encoder.encode("X"), 2)).toBe(3);
		expect(indexOfBytes(haystack, encoder.encode("Q"))).toBe(-1);
		expect(indexOfBytes(encoder.encode("ab"), encoder.encode("abc"))).toBe(-1);
	});
});

describe("isJavaScript", () => {
	it("recognizes the container content types", () => {
		for (const value of [
			"application/javascript",
			"application/javascript; charset=utf-8",
			"text/javascript",
			"application/x-javascript",
			"application/ecmascript",
		]) {
			expect(isJavaScript(value)).toBe(true);
		}
	});

	it("ignores everything else", () => {
		for (const value of ["text/html", "application/json", "text/css", "", null]) {
			expect(isJavaScript(value)).toBe(false);
		}
	});
});

describe("filterCookies", () => {
	it("keeps the analytics and first-party GTM cookies only", () => {
		const header = [
			"_ga=GA1.1",
			"session=abc",
			"_gid=1",
			"_gcl_au=x",
			"_fbp=f",
			"_fbc=c",
			"FPID=p",
			"FPLC=l",
			"FPAU=a",
			"FPGCL=g",
			"FPGSID=s",
			"_gtmeec=e",
			"theme=dark",
			"_ga_FOO=1",
		].join("; ");

		expect(filterCookies(header, DEFAULT_COOKIE_ALLOW)).toBe(
			[
				"_ga=GA1.1",
				"_gid=1",
				"_gcl_au=x",
				"_fbp=f",
				"_fbc=c",
				"FPID=p",
				"FPLC=l",
				"FPAU=a",
				"FPGCL=g",
				"FPGSID=s",
				"_gtmeec=e",
				"_ga_FOO=1",
			].join("; "),
		);
	});

	it("returns an empty string when nothing is allowed", () => {
		expect(filterCookies("session=abc", DEFAULT_COOKIE_ALLOW)).toBe("");
		expect(filterCookies(null, DEFAULT_COOKIE_ALLOW)).toBe("");
		expect(filterCookies("", DEFAULT_COOKIE_ALLOW)).toBe("");
	});

	it("ignores the global flag of a caller-supplied pattern", () => {
		expect(filterCookies("_ga=1; session=2; _ga=3", /^_ga/g)).toBe("_ga=1; _ga=3");
	});
});

describe("buildUpstreamHeaders", () => {
	it("drops Cloudflare headers and narrows the cookies", () => {
		const request = new Request("https://site.example/k7/x?a=1", {
			headers: {
				cookie: "_ga=1; session=2",
				host: "site.example",
				"user-agent": "test",
				"cf-connecting-ip": "203.0.113.7",
				"cf-ray": "8ff",
				"x-forwarded-for": "10.0.0.1",
				"x-forwarded-proto": "http",
			},
		});

		const headers = buildUpstreamHeaders(request, "203.0.113.7", DEFAULT_COOKIE_ALLOW);

		expect(headers.get("cookie")).toBe("_ga=1");
		expect(headers.get("user-agent")).toBe("test");
		expect(headers.get("cf-ray")).toBeNull();
		expect(headers.get("cf-connecting-ip")).toBeNull();
		expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
		expect(headers.get("x-forwarded-host")).toBe("site.example");
		expect(headers.get("x-forwarded-proto")).toBe("https");
	});

	it("leaves no client headers behind when the IP is unknown", () => {
		const request = new Request("https://site.example/k7/x", {
			headers: { "x-forwarded-for": "10.0.0.1" },
		});

		const headers = buildUpstreamHeaders(request, undefined, DEFAULT_COOKIE_ALLOW);

		expect(headers.get("x-forwarded-for")).toBeNull();
		expect(headers.get("x-forwarded-host")).toBe("site.example");
		expect(headers.get("cookie")).toBeNull();
	});
});

describe("getSetCookies", () => {
	it("returns every Set-Cookie header", () => {
		const response = new Response(null, {
			headers: [
				["set-cookie", "a=1; Path=/"],
				["set-cookie", "b=2; Path=/"],
			],
		});

		expect(getSetCookies(response.headers)).toEqual(["a=1; Path=/", "b=2; Path=/"]);
		expect(getSetCookies(new Headers())).toEqual([]);
	});
});

describe("rebuildResponse", () => {
	it("keeps the status, cache-control and every Set-Cookie", async () => {
		const upstream = new Response("old", {
			status: 201,
			statusText: "Created",
			headers: [
				["content-type", "application/javascript"],
				["cache-control", "public, max-age=300"],
				["content-length", "3"],
				["content-encoding", "gzip"],
				["etag", '"x"'],
				["set-cookie", "a=1; Path=/"],
				["set-cookie", "b=2; Path=/"],
			],
		});

		const rebuilt = rebuildResponse(upstream, encoder.encode("new"));

		expect(rebuilt.status).toBe(201);
		expect(rebuilt.statusText).toBe("Created");
		expect(rebuilt.headers.get("cache-control")).toBe("public, max-age=300");
		expect(rebuilt.headers.get("content-type")).toBe("application/javascript");
		expect(rebuilt.headers.get("content-length")).toBeNull();
		expect(rebuilt.headers.get("content-encoding")).toBeNull();
		expect(rebuilt.headers.get("etag")).toBeNull();
		expect(rebuilt.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
		expect(await rebuilt.text()).toBe("new");
	});

	it("overrides the content type for a served script", async () => {
		const rebuilt = rebuildResponse(
			new Response("x", { headers: { "content-type": "text/plain" } }),
			encoder.encode("y"),
			"application/javascript; charset=utf-8",
		);

		expect(rebuilt.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
		expect(await rebuilt.text()).toBe("y");
	});
});
