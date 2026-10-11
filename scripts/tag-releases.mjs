import { execFileSync } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Tags every package version on main that has no tag yet and creates its Forgejo release.
// npm publishing happens in the GitHub mirror (.github/workflows/release.yml).

const repository = process.env.GITHUB_REPOSITORY;
const apiUrl = process.env.GITHUB_API_URL;
const token = process.env.GITHUB_TOKEN;
if (!repository || !apiUrl || !token) {
	throw new Error("GITHUB_REPOSITORY, GITHUB_API_URL and GITHUB_TOKEN are required");
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changelogSection(changelog, version) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((line) => line.trim() === `## ${version}`);
	if (start === -1) return "";
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines
		.slice(start + 1, end === -1 ? undefined : end)
		.join("\n")
		.trim();
}

const packagesDir = path.resolve("packages");
const entries = (await readdir(packagesDir, { withFileTypes: true })).filter((entry) =>
	entry.isDirectory(),
);
const results = await Promise.all(
	entries.map(async (entry) => {
		const packageDir = path.join(packagesDir, entry.name);
		const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
		if (manifest.private) return null;

		const tag = `${manifest.name}@${manifest.version}`;
		if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) return null;

		git("tag", tag);
		git("push", "origin", `refs/tags/${tag}`);

		const changelog = await readFile(path.join(packageDir, "CHANGELOG.md"), "utf8").catch(() => "");
		const response = await fetch(`${apiUrl.replace(/\/$/, "")}/repos/${repository}/releases`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				tag_name: tag,
				name: tag,
				body: changelogSection(changelog, manifest.version),
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Creating the release ${tag} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
			);
		}
		console.log(`Released ${tag}`);
		return { name: manifest.name, version: manifest.version };
	}),
);
const published = results.filter(Boolean);

if (process.env.GITHUB_OUTPUT) {
	await appendFile(
		process.env.GITHUB_OUTPUT,
		`published=${published.length > 0}\npublished-packages=${JSON.stringify(published)}\n`,
	);
}
