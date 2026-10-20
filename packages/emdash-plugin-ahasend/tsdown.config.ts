import { defineConfig } from "tsdown";

// The sandbox entry imports the SDK by path so the self-contained EmDash bundle inlines it;
// npm consumers resolve the package itself instead.
const sdkEntry = {
	name: "ahasend-sdk-entry",
	resolveId(source: string) {
		if (source === "./sdk.js") return { id: "@ahasend/sdk", external: true };
	},
};

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
	external: ["emdash", /^emdash\//, "cloudflare:workers", "@ahasend/sdk"],
	plugins: [sdkEntry],
});
