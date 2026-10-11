import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Publishes every package version that is not on npm yet. Runs in the GitHub mirror,
// where npm Trusted Publishing authenticates through OIDC; no npm token exists.

function isPublished(name, version) {
	try {
		return (
			execFileSync("npm", ["view", `${name}@${version}`, "version"], {
				encoding: "utf8",
			}).trim() === version
		);
	} catch {
		return false;
	}
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

		const id = `${manifest.name}@${manifest.version}`;
		if (isPublished(manifest.name, manifest.version)) {
			console.log(`${id} is already on npm`);
			return null;
		}
		try {
			execFileSync("npm", ["publish", "--access", "public"], { cwd: packageDir, stdio: "inherit" });
			console.log(`Published ${id}`);
			return null;
		} catch {
			return id;
		}
	}),
);
const failures = results.filter(Boolean);

if (failures.length > 0) {
	throw new Error(`Publishing failed for ${failures.join(", ")}`);
}
