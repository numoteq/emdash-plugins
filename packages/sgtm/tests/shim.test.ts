import { describe, expect, it } from "vitest";

import { decodeTarget, derivePaths, type DerivedPaths } from "../src/codec.js";
import { renderSgtmShim, sgtmShimSource } from "../src/shim.js";

const paths = await derivePaths({ secret: "s3cret-per-site", prefix: "/k7" });

interface Harness {
	window: Record<string, unknown>;
	fetchCalls: unknown[];
	beacons: Array<[unknown, unknown]>;
	xhrCalls: Array<[string, string]>;
	scriptSrc: string[];
	imageSrc: string[];
	iframeSrc: string[];
	attributes: Array<[string, string]>;
}

/** Runs the shim against a minimal fake window; `window` is its only free identifier. */
function install(target: DerivedPaths, times = 1): Harness {
	const fetchCalls: unknown[] = [];
	const beacons: Array<[unknown, unknown]> = [];
	const xhrCalls: Array<[string, string]> = [];
	const scriptSrc: string[] = [];
	const imageSrc: string[] = [];
	const iframeSrc: string[] = [];
	const attributes: Array<[string, string]> = [];

	class FakeElement {
		setAttribute(name: string, value: string): void {
			attributes.push([name, value]);
		}
	}

	class FakeScript extends FakeElement {
		private current = "";
		get src(): string {
			return this.current;
		}
		set src(value: string) {
			this.current = value;
			scriptSrc.push(value);
		}
	}

	class FakeImage extends FakeElement {
		private current = "";
		get src(): string {
			return this.current;
		}
		set src(value: string) {
			this.current = value;
			imageSrc.push(value);
		}
	}

	class FakeIframe extends FakeElement {
		private current = "";
		get src(): string {
			return this.current;
		}
		set src(value: string) {
			this.current = value;
			iframeSrc.push(value);
		}
	}

	class FakeXhr {
		open(method: string, url: string): void {
			xhrCalls.push([method, url]);
		}
	}

	const fakeWindow: Record<string, unknown> = {
		location: { href: "https://site.example/post/", origin: "https://site.example" },
		crypto: globalThis.crypto,
		URL: globalThis.URL,
		Request: globalThis.Request,
		TextEncoder: globalThis.TextEncoder,
		fetch: (input: unknown) => {
			fetchCalls.push(input);
			return Promise.resolve(new Response("ok"));
		},
		navigator: {
			sendBeacon: (url: unknown, data?: unknown) => {
				beacons.push([url, data]);
				return true;
			},
		},
		XMLHttpRequest: FakeXhr,
		Element: FakeElement,
		HTMLScriptElement: FakeScript,
		HTMLImageElement: FakeImage,
		HTMLIFrameElement: FakeIframe,
	};

	const run = new Function("window", sgtmShimSource(target)) as (window: unknown) => void;
	for (let index = 0; index < times; index += 1) run(fakeWindow);

	return {
		window: fakeWindow,
		fetchCalls,
		beacons,
		xhrCalls,
		scriptSrc,
		imageSrc,
		iframeSrc,
		attributes,
	};
}

function fetcher(harness: Harness): (input: unknown) => Promise<Response> {
	return harness.window["fetch"] as (input: unknown) => Promise<Response>;
}

/** The `pathname + search` a rewritten URL stands for, or `null` when it was not rewritten. */
function plaintext(value: unknown): string | null {
	if (typeof value !== "string" || !value.startsWith("https://site.example")) return null;
	const url = new URL(value);
	if (!url.pathname.startsWith(`${paths.encodedPrefix}/`)) return null;
	return decodeTarget(url.pathname.slice(paths.encodedPrefix.length + 1), paths.seed, paths.prefix);
}

describe("sgtmLoaderShim", () => {
	it("encodes a same-origin request under the prefix and the decoder restores it", async () => {
		const harness = install(paths);
		await fetcher(harness)("/k7/gtm.js?v=2&tid=G-X");

		expect(harness.fetchCalls).toHaveLength(1);
		const encoded = harness.fetchCalls[0];
		expect(typeof encoded).toBe("string");
		expect(String(encoded).startsWith(`https://site.example${paths.encodedPrefix}/`)).toBe(true);
		expect(plaintext(String(encoded))).toBe("/k7/gtm.js?v=2&tid=G-X");
	});

	it("resolves relative requests against the document", async () => {
		const harness = install(paths);
		await fetcher(harness)("../k7/collect");

		expect(harness.fetchCalls).toHaveLength(1);
		expect(String(harness.fetchCalls[0]).startsWith("https://site.example/")).toBe(true);
		expect(plaintext(String(harness.fetchCalls[0]))).toBe("/k7/collect");
	});

	it("leaves other origins, other paths, the loader and encoded URLs alone", async () => {
		const harness = install(paths);
		const fetch = fetcher(harness);

		const untouched: unknown[] = [
			"https://www.googletagmanager.com/gtm.js?id=GTM-X",
			"https://other.example/k7/x",
			"//other.example/k7/x",
			"https://site.example/api/thing",
			paths.loaderPath,
			`${paths.encodedPrefix}/AAAA`,
		];
		await Promise.all(untouched.map(async (value) => fetch(value)));

		expect(harness.fetchCalls).toEqual(untouched);
	});

	it("keeps method, headers, body and credentials of a Request", async () => {
		const harness = install(paths);
		const request = new Request("https://site.example/k7/collect", {
			method: "POST",
			body: "a=1",
			headers: { "x-a": "b" },
			credentials: "include",
			referrerPolicy: "no-referrer",
		});

		await fetcher(harness)(request);

		const forwarded = harness.fetchCalls[0] as Request;
		expect(forwarded).toBeInstanceOf(Request);
		expect(forwarded.method).toBe("POST");
		expect(forwarded.headers.get("x-a")).toBe("b");
		expect(forwarded.credentials).toBe("include");
		expect(forwarded.referrerPolicy).toBe("no-referrer");
		expect(plaintext(forwarded.url)).toBe("/k7/collect");
		expect(await forwarded.text()).toBe("a=1");
	});

	it("keeps keepalive and leaves a Request outside the prefix untouched", async () => {
		const harness = install(paths);
		const keepalive = new Request("https://site.example/k7/ping", { keepalive: true });
		const foreign = new Request("https://other.example/k7/ping");

		await fetcher(harness)(keepalive);
		await fetcher(harness)(foreign);

		const forwarded = harness.fetchCalls[0] as Request;
		expect(forwarded.keepalive).toBe(true);
		expect(forwarded.method).toBe("GET");
		expect(plaintext(forwarded.url)).toBe("/k7/ping");
		expect(harness.fetchCalls[1]).toBe(foreign);
	});

	it("accepts a URL object", async () => {
		const harness = install(paths);
		await fetcher(harness)(new URL("https://site.example/k7/collect"));

		expect(plaintext(String(harness.fetchCalls[0]))).toBe("/k7/collect");
	});

	it("rewrites sendBeacon, XMLHttpRequest.open, src setters and setAttribute", () => {
		const harness = install(paths);
		const navigator = harness.window["navigator"] as {
			sendBeacon: (url: string, body: string) => boolean;
		};
		const Xhr = harness.window["XMLHttpRequest"] as new () => {
			open(method: string, url: string): void;
		};
		const Script = harness.window["HTMLScriptElement"] as new () => { src: string };
		const Image = harness.window["HTMLImageElement"] as new () => { src: string };
		const Iframe = harness.window["HTMLIFrameElement"] as new () => { src: string };
		const Element = harness.window["Element"] as new () => {
			setAttribute(name: string, value: string): void;
		};

		navigator.sendBeacon("/k7/beacon", "payload");
		new Xhr().open("POST", "/k7/xhr");
		const script = new Script();
		script.src = "/k7/collect.js";
		script.src = "https://cdn.example/other.js";
		const image = new Image();
		image.src = "/k7/pixel.gif";
		const iframe = new Iframe();
		iframe.src = "/k7/ns.html?id=GTM-X";
		const element = new Element();
		element.setAttribute("src", "/k7/legacy.js");
		element.setAttribute("href", "/k7/not-a-src.js");

		expect(harness.beacons).toHaveLength(1);
		expect(harness.beacons[0]![1]).toBe("payload");
		expect(plaintext(String(harness.beacons[0]![0]))).toBe("/k7/beacon");
		expect(harness.xhrCalls).toHaveLength(1);
		expect(harness.xhrCalls[0]![0]).toBe("POST");
		expect(plaintext(harness.xhrCalls[0]![1])).toBe("/k7/xhr");
		expect(plaintext(harness.scriptSrc[0])).toBe("/k7/collect.js");
		expect(harness.scriptSrc[1]).toBe("https://cdn.example/other.js");
		expect(plaintext(harness.imageSrc[0])).toBe("/k7/pixel.gif");
		expect(plaintext(harness.iframeSrc[0])).toBe("/k7/ns.html?id=GTM-X");
		expect(plaintext(harness.attributes[0]![1])).toBe("/k7/legacy.js");
		expect(harness.attributes[0]![0]).toBe("src");
		expect(harness.attributes[1]).toEqual(["href", "/k7/not-a-src.js"]);
	});

	it("installs itself once", async () => {
		const harness = install(paths, 2);

		expect(harness.window["__numoteqSgtm"]).toBe(true);
		await fetcher(harness)("/k7/once");
		expect(harness.fetchCalls).toHaveLength(1);
		expect(plaintext(String(harness.fetchCalls[0]))).toBe("/k7/once");
	});

	it("ships as a self-guarding IIFE with the derived paths baked in", async () => {
		const rendered = renderSgtmShim(paths);
		expect(rendered.startsWith("(function (window) {\n")).toBe(true);
		expect(rendered.trimEnd().endsWith("})(window);")).toBe(true);
		expect(rendered).toContain(JSON.stringify(paths.prefix));
		expect(rendered).toContain(JSON.stringify(paths.loaderPath));
		expect(rendered).toContain(JSON.stringify(paths.encodedPrefix));
		expect(rendered).toContain(String(paths.seed));
	});
});
