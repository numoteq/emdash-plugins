import { defineConfig } from "tsdown";

// Native entry points and the API client; `emdash-plugin build` handles the sandboxed plugin.
export default defineConfig({
	entry: {
		client: "src/client.ts",
		"native/index": "src/native/index.ts",
		"native/plugin": "src/native/plugin.ts",
	},
	format: "esm",
	dts: true,
	clean: false,
	outDir: "dist",
	external: ["emdash", /^emdash\//, "cloudflare:workers"],
});
