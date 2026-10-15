import { defineConfig } from "tsdown";

// A plain library: no emdash-plugin descriptor or sandbox bundle.
export default defineConfig({
	entry: { index: "src/index.ts" },
	format: "esm",
	dts: true,
	clean: true,
	outDir: "dist",
});
