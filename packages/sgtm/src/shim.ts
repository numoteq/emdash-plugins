import type { DerivedPaths } from "./codec.js";

/**
 * The shim prepended to `gtm.js`. It encodes every same-origin request under the prefix, through
 * the only channels gtm.js and gtag.js send with: `fetch`, `sendBeacon` and the `src` of script
 * and image elements. Iframes stay plain on purpose: the service worker iframe then gets a 404
 * and gtag sends from the page instead.
 *
 * The keystream helpers are copies of the ones in `codec.ts`; the tests round-trip both.
 * `window` is the only free identifier, so tests can run the shim against a fake window.
 */
export function shimSource(paths: DerivedPaths): string {
	return `"use strict";
	if (window.__sgtmShim) return;
	window.__sgtmShim = true;

	var PREFIX = ${JSON.stringify(`${paths.prefix}/`)};
	var LOADER = ${JSON.stringify(paths.loaderPath)};
	var ENCODED = ${JSON.stringify(`${paths.encodedPrefix}/`)};
	var SEED = ${String(paths.seed)};
	var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

	function base64url(bytes) {
		var output = "";
		for (var index = 0; index < bytes.length; index += 3) {
			var first = bytes[index];
			var second = bytes[index + 1];
			var third = bytes[index + 2];
			output += ALPHABET.charAt(first >> 2);
			if (second === undefined) {
				output += ALPHABET.charAt((first & 3) << 4);
				break;
			}
			output += ALPHABET.charAt(((first & 3) << 4) | (second >> 4));
			if (third === undefined) {
				output += ALPHABET.charAt((second & 15) << 2);
				break;
			}
			output += ALPHABET.charAt(((second & 15) << 2) | (third >> 6));
			output += ALPHABET.charAt(third & 63);
		}
		return output;
	}

	function keystream(data, seed) {
		var state = seed >>> 0;
		var output = new Uint8Array(data.length);
		for (var index = 0; index < data.length; index += 4) {
			state = (state + 0x6d2b79f5) >>> 0;
			var word = state;
			word = Math.imul(word ^ (word >>> 15), word | 1);
			word = (word + Math.imul(word ^ (word >>> 7), word | 61)) ^ word;
			word = (word ^ (word >>> 14)) >>> 0;
			for (var offset = 0; offset < 4 && index + offset < data.length; offset += 1) {
				output[index + offset] = data[index + offset] ^ ((word >>> (8 * offset)) & 255);
			}
		}
		return output;
	}

	function rewrite(value) {
		try {
			// Script URLs arrive as TrustedScriptURL where Trusted Types exist; they stringify to the URL.
			var url = new window.URL(String(value), window.location.href);
			if (
				url.origin !== window.location.origin ||
				url.pathname.indexOf(PREFIX) !== 0 ||
				url.pathname === LOADER ||
				url.pathname.indexOf(ENCODED) === 0
			) {
				return value;
			}
			var salt = window.crypto.getRandomValues(new Uint8Array(4));
			var plain = new window.TextEncoder().encode(url.pathname + url.search);
			var masked = keystream(plain, (((salt[0] << 24) | (salt[1] << 16) | (salt[2] << 8) | salt[3]) ^ SEED) >>> 0);
			var token = new Uint8Array(4 + masked.length);
			token.set(salt, 0);
			token.set(masked, 4);
			return url.origin + ENCODED + base64url(token);
		} catch (error) {
			return value;
		}
	}

	var nativeFetch = window.fetch;
	if (typeof nativeFetch === "function") {
		window.fetch = function (input, init) {
			var target = typeof input === "string" || input instanceof window.URL ? rewrite(input) : input;
			return nativeFetch.call(this, target, init);
		};
	}

	var navigator = window.navigator;
	if (navigator && typeof navigator.sendBeacon === "function") {
		var nativeSendBeacon = navigator.sendBeacon;
		navigator.sendBeacon = function (url, data) {
			return nativeSendBeacon.call(navigator, rewrite(url), data);
		};
	}

	function hookSrc(element) {
		var prototype = element && element.prototype;
		var descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "src");
		if (!descriptor || !descriptor.get || !descriptor.set) return;
		Object.defineProperty(prototype, "src", {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set: function (value) {
				var rewritten = rewrite(value);
				try {
					descriptor.set.call(this, rewritten);
				} catch (error) {
					// A Trusted Types policy rejects the plain string; fall back to the original value.
					descriptor.set.call(this, value);
				}
			},
		});
	}

	hookSrc(window.HTMLScriptElement);
	hookSrc(window.HTMLImageElement);`;
}

/** The shim as served: an IIFE that guards itself with a window flag. */
export function renderShim(paths: DerivedPaths): string {
	return `(function (window) {\n${shimSource(paths)}\n})(window);\n`;
}
