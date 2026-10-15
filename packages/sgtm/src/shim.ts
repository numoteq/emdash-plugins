import type { DerivedPaths } from "./codec.js";

/**
 * The shim that is prepended to `gtm.js`. It runs before any container code, needs no dependencies
 * and rewrites only requests that already go to the sGTM prefix.
 *
 * The keystream helpers below are byte-for-byte copies of the ones in `codec.ts`; `tests/shim.test.ts`
 * round-trips both implementations against each other.
 *
 * {@link renderSgtmShim} wraps this source in an IIFE with `window` as its only free identifier, so
 * tests can run it against a fake window.
 */
export function sgtmShimSource(paths: DerivedPaths): string {
	return `"use strict";
	if (window.__numoteqSgtm) {
		return;
	}
	window.__numoteqSgtm = true;

	var PREFIX = ${JSON.stringify(paths.prefix)};
	var LOADER = ${JSON.stringify(paths.loaderPath)};
	var ENCODED = ${JSON.stringify(paths.encodedPrefix)};
	var SEED = ${String(paths.seed)};

	var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	var VALUES = {};
	for (var i = 0; i < ALPHABET.length; i += 1) {
		VALUES[ALPHABET.charAt(i)] = i;
	}

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

	function mulberry32(seed) {
		var state = seed >>> 0;
		return function () {
			state = (state + 0x6d2b79f5) >>> 0;
			var value = state;
			value = Math.imul(value ^ (value >>> 15), value | 1);
			value = (value + Math.imul(value ^ (value >>> 7), value | 61)) ^ value;
			return (value ^ (value >>> 14)) >>> 0;
		};
	}

	function keystream(data, seed) {
		var next = mulberry32(seed);
		var output = new Uint8Array(data.length);
		for (var index = 0; index < data.length; index += 4) {
			var word = next();
			for (var offset = 0; offset < 4 && index + offset < data.length; offset += 1) {
				output[index + offset] = data[index + offset] ^ ((word >>> (8 * offset)) & 255);
			}
		}
		return output;
	}

	function encode(value) {
		if (typeof value !== "string" || value === "") {
			return null;
		}
		var url;
		try {
			url = new window.URL(value, window.location.href);
		} catch (error) {
			void error;
			return null;
		}
		if (url.origin !== window.location.origin) {
			return null;
		}
		if (url.pathname.indexOf(PREFIX + "/") !== 0) {
			return null;
		}
		if (url.pathname === LOADER) {
			return null;
		}
		if (url.pathname === ENCODED || url.pathname.indexOf(ENCODED + "/") === 0) {
			return null;
		}

		var salt = window.crypto.getRandomValues(new Uint8Array(4));
		var saltWord = ((salt[0] << 24) | (salt[1] << 16) | (salt[2] << 8) | salt[3]) >>> 0;
		var plain = new window.TextEncoder().encode(url.pathname + url.search);
		var masked = keystream(plain, (saltWord ^ SEED) >>> 0);
		var token = new Uint8Array(4 + masked.length);
		token.set(salt, 0);
		token.set(masked, 4);
		return url.origin + ENCODED + "/" + base64url(token);
	}

	function rewrite(value) {
		try {
			var encoded = encode(value);
			return encoded === null ? value : encoded;
		} catch (error) {
			void error;
			return value;
		}
	}

	var nativeFetch = window.fetch;
	if (typeof nativeFetch === "function") {
		window.fetch = function (input, init) {
			try {
				if (typeof input === "string") {
					input = rewrite(input);
				} else if (typeof window.URL === "function" && input instanceof window.URL) {
					input = rewrite(input.href);
				} else if (typeof window.Request === "function" && input instanceof window.Request) {
					var encodedRequest = encode(input.url);
					if (encodedRequest !== null) {
						// A Request as init copies method, body, headers, credentials and keepalive.
						input = new window.Request(encodedRequest, input);
					}
				}
			} catch (error) {
				void error;
			}
			return nativeFetch.call(this, input, init);
		};
	}

	var browserNavigator = window.navigator;
	if (browserNavigator && typeof browserNavigator.sendBeacon === "function") {
		var nativeSendBeacon = browserNavigator.sendBeacon;
		browserNavigator.sendBeacon = function (url, data) {
			return nativeSendBeacon.call(browserNavigator, rewrite(url), data);
		};
	}

	if (typeof window.XMLHttpRequest === "function") {
		var nativeOpen = window.XMLHttpRequest.prototype.open;
		window.XMLHttpRequest.prototype.open = function (method, url) {
			var args = Array.prototype.slice.call(arguments);
			args[1] = rewrite(url);
			return nativeOpen.apply(this, args);
		};
	}

	function hookSrc(prototype) {
		if (!prototype) {
			return;
		}
		var descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
		if (!descriptor || typeof descriptor.set !== "function" || !descriptor.get) {
			return;
		}
		Object.defineProperty(prototype, "src", {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set: function (value) {
				return descriptor.set.call(this, rewrite(value));
			},
		});
	}

	hookSrc(window.HTMLScriptElement && window.HTMLScriptElement.prototype);
	hookSrc(window.HTMLImageElement && window.HTMLImageElement.prototype);
	hookSrc(window.HTMLIFrameElement && window.HTMLIFrameElement.prototype);

	if (typeof window.Element === "function") {
		var nativeSetAttribute = window.Element.prototype.setAttribute;
		window.Element.prototype.setAttribute = function (name, value) {
			if (typeof name === "string" && name.toLowerCase() === "src") {
				return nativeSetAttribute.call(this, name, rewrite(value));
			}
			return nativeSetAttribute.call(this, name, value);
		};
	}`;
}

/** The shim as served: an ES2017 IIFE that guards itself with a window flag. */
export function renderSgtmShim(paths: DerivedPaths): string {
	return `(function (window) {\n${sgtmShimSource(paths)}\n})(window);\n`;
}
