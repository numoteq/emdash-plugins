import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const publishedPackages = JSON.parse(process.env.PUBLISHED_PACKAGES ?? "[]");

if (!repository) throw new Error("GITHUB_REPOSITORY is required");
if (!Array.isArray(publishedPackages)) throw new Error("PUBLISHED_PACKAGES must be an array");

const packagesDir = path.resolve("packages");
const packageDirectories = (await readdir(packagesDir, { withFileTypes: true })).filter((entry) =>
	entry.isDirectory(),
);
const workspacePackages = new Map(
	await Promise.all(
		packageDirectories.map(async (directory) => {
			const packageDir = path.join(packagesDir, directory.name);
			const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
			const manifestPath = path.join(packageDir, "emdash-plugin.jsonc");
			let manifest;
			try {
				manifest = await readFile(manifestPath, "utf8");
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			return [packageJson.name, { packageDir, manifest, manifestPath }];
		}),
	),
);

for (const publishedPackage of publishedPackages) {
	if (typeof publishedPackage?.name !== "string" || typeof publishedPackage?.version !== "string") {
		throw new Error("Published package entries must contain name and version strings");
	}

	const workspacePackage = workspacePackages.get(publishedPackage.name);
	if (!workspacePackage) throw new Error(`Workspace package not found: ${publishedPackage.name}`);
	if (!workspacePackage.manifest) continue;

	const { packageDir, manifest, manifestPath } = workspacePackage;
	const slug = manifest.match(/"slug"\s*:\s*"([a-z][a-z0-9_-]*)"/)?.[1];
	if (!slug) throw new Error(`Plugin slug not found in ${manifestPath}`);

	execFileSync("pnpm", ["--filter", publishedPackage.name, "exec", "emdash-plugin", "bundle"], {
		stdio: "inherit",
	});

	const tag = `${publishedPackage.name}@${publishedPackage.version}`;
	const bundle = path.join(packageDir, "dist", `${slug}-${publishedPackage.version}.tar.gz`);
	execFileSync("gh", ["release", "upload", tag, bundle, "--repo", repository, "--clobber"], {
		stdio: "inherit",
	});
}
