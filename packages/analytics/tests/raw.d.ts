/** Vite's `?raw` imports, used to load the gtm.js excerpt verbatim. */
declare module "*?raw" {
	const content: string;
	export default content;
}
