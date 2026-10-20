import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { index: "src/index.ts", client: "src/client.ts", astro: "src/astro.ts" },
	format: "esm",
	dts: true,
	clean: true,
	outDir: "dist",
});
