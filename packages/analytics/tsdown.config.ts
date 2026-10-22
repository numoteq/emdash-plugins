import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		client: "src/client.ts",
		server: "src/server/index.ts",
		astro: "src/astro.ts",
		c15t: "src/c15t.ts",
	},
	format: "esm",
	dts: true,
	clean: true,
	outDir: "dist",
});
