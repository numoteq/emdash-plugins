import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const apiUrl = process.env.GITHUB_API_URL;
const token = process.env.GITHUB_TOKEN;
const publishedPackages = JSON.parse(process.env.PUBLISHED_PACKAGES ?? "[]");

if (!repository) throw new Error("GITHUB_REPOSITORY is required");
if (!apiUrl) throw new Error("GITHUB_API_URL is required");
if (!token) throw new Error("GITHUB_TOKEN is required");
if (!Array.isArray(publishedPackages)) throw new Error("PUBLISHED_PACKAGES must be an array");

const [owner, repo, ...extraRepositoryParts] = repository.split("/");
if (!owner || !repo || extraRepositoryParts.length > 0) {
	throw new Error("GITHUB_REPOSITORY must use the owner/repository format");
}

const repositoryApiPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

async function forgejoRequest(apiPath, init = {}) {
	const response = await fetch(`${apiUrl.replace(/\/$/, "")}/${apiPath}`, {
		...init,
		headers: {
			Accept: "application/json",
			Authorization: `token ${token}`,
			...init.headers,
		},
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 1_000);
		throw new Error(
			`Forgejo API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	return response;
}

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

await Promise.all(
	publishedPackages.map(async (publishedPackage) => {
		if (
			typeof publishedPackage?.name !== "string" ||
			typeof publishedPackage?.version !== "string"
		) {
			throw new Error("Published package entries must contain name and version strings");
		}

		const workspacePackage = workspacePackages.get(publishedPackage.name);
		if (!workspacePackage) throw new Error(`Workspace package not found: ${publishedPackage.name}`);
		if (!workspacePackage.manifest) return;

		const { packageDir, manifest, manifestPath } = workspacePackage;
		const slug = manifest.match(/"slug"\s*:\s*"([a-z][a-z0-9_-]*)"/)?.[1];
		if (!slug) throw new Error(`Plugin slug not found in ${manifestPath}`);

		execFileSync("pnpm", ["--filter", publishedPackage.name, "exec", "emdash-plugin", "bundle"], {
			stdio: "inherit",
		});

		const tag = `${publishedPackage.name}@${publishedPackage.version}`;
		const bundle = path.join(packageDir, "dist", `${slug}-${publishedPackage.version}.tar.gz`);
		const releaseResponse = await forgejoRequest(
			`${repositoryApiPath}/releases/tags/${encodeURIComponent(tag)}`,
		);
		const release = await releaseResponse.json();
		if (!Number.isInteger(release.id) || !Array.isArray(release.assets)) {
			throw new Error(`Invalid Forgejo release response for ${tag}`);
		}

		const assetName = path.basename(bundle);
		const existingAsset = release.assets.find((asset) => asset?.name === assetName);
		if (existingAsset) {
			if (!Number.isInteger(existingAsset.id)) {
				throw new Error(`Invalid Forgejo asset response for ${assetName}`);
			}
			await forgejoRequest(`${repositoryApiPath}/releases/assets/${existingAsset.id}`, {
				method: "DELETE",
			});
		}

		await forgejoRequest(
			`${repositoryApiPath}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: await readFile(bundle),
			},
		);
	}),
);
