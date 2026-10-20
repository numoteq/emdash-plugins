import { describe, expect, it } from "@effect/vitest";

import { decodeToken, derivePaths } from "../src/codec.js";
import { renderShim, shimSource } from "../src/shim.js";

const paths = derivePaths("GTM-NTQ37T97", "/k7", "");
const origin = "https://site.example";

/** Stand-in for TrustedScriptURL: an opaque object that stringifies to the URL. */
class FakeTrustedScriptURL {
	constructor(private readonly url: string) {}
	toString(): string {
		return this.url;
	}
}

/** Runs the shim against a minimal fake window and records what reaches the native APIs. */
function install(options: { times?: number; trustedTypes?: boolean } = {}) {
	const sent: unknown[] = [];

	const element = (record: boolean, enforce = false) =>
		class {
			#src: unknown = "";
			get src(): unknown {
				return this.#src;
			}
			set src(value: unknown) {
				if (enforce && typeof value === "string") throw new TypeError("TrustedScriptURL required");
				this.#src = value;
				if (record) sent.push(value);
			}
		};

	const window: Record<string, unknown> = {
		location: { href: `${origin}/blog/`, origin },
		crypto: globalThis.crypto,
		URL: globalThis.URL,
		TextEncoder: globalThis.TextEncoder,
		fetch: (input: unknown) => {
			sent.push(input);
			return Promise.resolve(new Response("ok"));
		},
		navigator: {
			sendBeacon: (url: unknown) => {
				sent.push(url);
				return true;
			},
		},
		HTMLScriptElement: element(true, options.trustedTypes),
		HTMLImageElement: element(true),
		HTMLIFrameElement: element(true),
	};

	const run = new Function("window", shimSource(paths)) as (window: unknown) => void;
	for (let index = 0; index < (options.times ?? 1); index += 1) run(window);

	const create = (name: string) => new (window[name] as new () => { src: unknown })();
	return { window, sent, create };
}

/** The `pathname + search` an encoded URL stands for, or `null` when it was not encoded. */
function decoded(value: unknown): string | null {
	const url = new URL(String(value));
	if (url.origin !== origin || !url.pathname.startsWith(`${paths.encodedPrefix}/`)) return null;
	return decodeToken(url.pathname.slice(paths.encodedPrefix.length + 1), paths);
}

const hit = "/k7/g/collect?v=2&tid=G-WSNXXNBYV7&en=page_view";

describe("shim", () => {
	it("encodes fetch, sendBeacon, script and image requests under the prefix", async () => {
		const { window, sent, create } = install();

		await (window["fetch"] as (input: unknown) => Promise<Response>)(`${origin}${hit}`);
		await (window["fetch"] as (input: unknown) => Promise<Response>)(new URL(hit, origin));
		(window["navigator"] as { sendBeacon: (url: string) => boolean }).sendBeacon(hit);
		create("HTMLScriptElement").src = "/k7/gtag/js?id=G-WSNXXNBYV7";
		create("HTMLImageElement").src = `${origin}${hit}`;

		expect(sent.map(decoded)).toEqual([hit, hit, hit, "/k7/gtag/js?id=G-WSNXXNBYV7", hit]);
		for (const value of sent) {
			expect(String(value)).not.toContain("collect");
			expect(String(value)).not.toContain("G-");
		}
	});

	it("gives every request a different token", () => {
		const { sent, create } = install();
		create("HTMLImageElement").src = hit;
		create("HTMLImageElement").src = hit;
		expect(sent[0]).not.toBe(sent[1]);
	});

	it("leaves other origins, other paths, the loader and encoded URLs alone", () => {
		const { sent, create } = install();
		const untouched = [
			"https://www.google-analytics.com/g/collect?v=2",
			"/api/contact",
			"/k7",
			paths.loaderPath,
			`${paths.encodedPrefix}/abc`,
		];
		for (const url of untouched) create("HTMLImageElement").src = url;
		expect(sent).toEqual(untouched);
	});

	it("keeps iframes plain, so the service worker iframe is refused", () => {
		const { sent, create } = install();
		const iframe = "/k7/_/service_worker/6a60/sw_iframe.html?origin=https%3A%2F%2Fsite.example";
		create("HTMLIFrameElement").src = iframe;
		expect(sent).toEqual([iframe]);
	});

	it("encodes TrustedScriptURL values and falls back where Trusted Types reject strings", () => {
		const plain = install();
		plain.create("HTMLScriptElement").src = new FakeTrustedScriptURL(`${origin}/k7/gtag/js?id=G-X`);
		expect(decoded(plain.sent[0])).toBe("/k7/gtag/js?id=G-X");

		const enforced = install({ trustedTypes: true });
		const original = new FakeTrustedScriptURL(`${origin}/k7/gtag/js?id=G-X`);
		enforced.create("HTMLScriptElement").src = original;
		expect(enforced.sent).toEqual([original]);
	});

	it("hooks only once when loaded twice", () => {
		const { sent, create } = install({ times: 2 });
		create("HTMLImageElement").src = hit;
		expect(decoded(sent[0])).toBe(hit);
	});

	it("renders as a self-contained IIFE", () => {
		expect(renderShim(paths)).toMatch(/^\(function \(window\) \{\n[\s\S]*\n\}\)\(window\);\n$/);
	});
});
