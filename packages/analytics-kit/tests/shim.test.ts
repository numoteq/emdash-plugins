import { describe, expect, it } from "@effect/vitest";

import { decodeToken } from "../src/codec.js";
import { encodedPrefix, loaderPath } from "../src/paths.js";
import { renderShim, shimSource } from "../src/shim.js";

const origin = "https://site.example";
const encoded = encodedPrefix("site.example");

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

	const element = (enforce = false) =>
		class {
			#src: unknown = "";
			get src(): unknown {
				return this.#src;
			}
			set src(value: unknown) {
				if (enforce && typeof value === "string") throw new TypeError("TrustedScriptURL required");
				this.#src = value;
				sent.push(value);
			}
		};

	// An iframe whose empty document is its own realm, as the one gtag nests the worker iframe in.
	const child = { HTMLIFrameElement: element() };
	const frame = element();
	Object.defineProperty(frame.prototype, "contentDocument", {
		configurable: true,
		get: () => ({ defaultView: child }),
	});

	const window: Record<string, unknown> = {
		location: { href: `${origin}/blog/`, origin },
		crypto: globalThis.crypto,
		URL: globalThis.URL,
		btoa: globalThis.btoa,
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
		HTMLScriptElement: element(options.trustedTypes),
		HTMLImageElement: element(),
		HTMLIFrameElement: frame,
	};

	const run = new Function("window", shimSource(encoded)) as (window: unknown) => void;
	for (let index = 0; index < (options.times ?? 1); index += 1) run(window);

	const create = (name: string) => new (window[name] as new () => { src: unknown })();
	return { window, sent, create };
}

/** The internal path an encoded URL stands for, or `null` when it was not encoded. */
function decoded(value: unknown): string | null {
	const url = new URL(String(value));
	if (url.origin !== origin || !url.pathname.startsWith(encoded)) return null;
	return decodeToken(url.pathname.slice(encoded.length));
}

const sgtmHit = "/_sgtm/g/collect?v=2&tid=G-WSNXXNBYV7&en=page_view";
const openpanelHit = "/_op/track";

describe("shim", () => {
	it("encodes fetch, sendBeacon, script and image requests under both prefixes", async () => {
		const { window, sent, create } = install();

		await (window["fetch"] as (input: unknown) => Promise<Response>)(`${origin}${sgtmHit}`);
		await (window["fetch"] as (input: unknown) => Promise<Response>)(new URL(sgtmHit, origin));
		(window["navigator"] as { sendBeacon: (url: string) => boolean }).sendBeacon(openpanelHit);
		create("HTMLScriptElement").src = "/_sgtm/gtag/js?id=G-WSNXXNBYV7";
		create("HTMLImageElement").src = `${origin}${openpanelHit}`;

		expect(sent.map(decoded)).toEqual([
			sgtmHit,
			sgtmHit,
			openpanelHit,
			"/_sgtm/gtag/js?id=G-WSNXXNBYV7",
			openpanelHit,
		]);
		for (const value of sent) {
			expect(String(value)).not.toContain("/_sgtm");
			expect(String(value)).not.toContain("/_op");
			expect(String(value)).not.toContain("collect");
		}
	});

	it("leaves the OpenPanel SDK's own .js paths untouched", () => {
		const { sent, create } = install();
		const scripts = ["/_op/op1.js", "/_op/op1-replay.js"];
		for (const script of scripts) create("HTMLScriptElement").src = script;
		expect(sent).toEqual(scripts);
	});

	it("gives every request a different token", () => {
		const { sent, create } = install();
		create("HTMLImageElement").src = sgtmHit;
		create("HTMLImageElement").src = sgtmHit;
		expect(sent[0]).not.toBe(sent[1]);
	});

	it("leaves other origins, other paths, the loader and encoded URLs alone", () => {
		const { sent, create } = install();
		const untouched = [
			"https://www.google-analytics.com/g/collect?v=2",
			"https://other.example/_sgtm/g/collect",
			"/api/contact",
			"/_sgtm",
			loaderPath("site.example"),
			`${encoded}abc`,
		];
		for (const url of untouched) create("HTMLImageElement").src = url;
		expect(sent).toEqual(untouched);
	});

	it("never loads the service worker iframe, but leaves other iframes alone", () => {
		const { sent, create } = install();
		create("HTMLIFrameElement").src =
			"/_sgtm/_/service_worker/6a60/sw_iframe.html?origin=https%3A%2F%2Fsite.example";
		create("HTMLIFrameElement").src = "https://www.youtube.com/embed/x";
		expect(sent).toEqual(["https://www.youtube.com/embed/x"]);
	});

	it("never loads the service worker iframe from inside a same-origin frame either", () => {
		const { sent, create } = install();
		const outer = create("HTMLIFrameElement") as unknown as {
			contentDocument: { defaultView: Record<string, new () => { src: unknown }> };
		};
		const Inner = outer.contentDocument.defaultView["HTMLIFrameElement"]!;
		new Inner().src = "/_sgtm/_/service_worker/6a60/sw_iframe.html";
		new Inner().src = "/embed";
		expect(sent).toEqual(["/embed"]);
	});

	it("encodes TrustedScriptURL values and falls back where Trusted Types reject strings", () => {
		const plain = install();
		plain.create("HTMLScriptElement").src = new FakeTrustedScriptURL(
			`${origin}/_sgtm/gtag/js?id=G-X`,
		);
		expect(decoded(plain.sent[0])).toBe("/_sgtm/gtag/js?id=G-X");

		const enforced = install({ trustedTypes: true });
		const original = new FakeTrustedScriptURL(`${origin}/_sgtm/gtag/js?id=G-X`);
		enforced.create("HTMLScriptElement").src = original;
		expect(enforced.sent).toEqual([original]);
	});

	it("hooks only once when loaded twice", () => {
		const { sent, create } = install({ times: 2 });
		create("HTMLImageElement").src = sgtmHit;
		expect(decoded(sent[0])).toBe(sgtmHit);
	});

	it("renders as a self-contained IIFE", () => {
		expect(renderShim(encoded)).toMatch(/^\(function \(window\) \{\n[\s\S]*\n\}\)\(window\);\n$/);
	});
});
