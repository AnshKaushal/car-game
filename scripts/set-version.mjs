/**
 * Stamps the release version into electrobun.config.ts before a CI build.
 *
 *   node scripts/set-version.mjs 1.0.1
 *
 * The release version lives in git tags (see .github/workflows/release.yml);
 * this only makes the built app and its update metadata report the same
 * number. Nothing written here is committed back.
 */

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
	console.error(`set-version: expected a version like 1.0.1, got "${version ?? ""}"`);
	process.exit(1);
}

const path = "electrobun.config.ts";
const source = readFileSync(path, "utf8");
const pattern = /(identifier:\s*"car\.game\.dev",\s*version:\s*)"[^"]*"/;

if (!pattern.test(source)) {
	console.error(`set-version: could not find app.version next to identifier in ${path}`);
	process.exit(1);
}

writeFileSync(path, source.replace(pattern, (_, prefix) => `${prefix}"${version}"`));
console.log(`${path}: app.version -> ${version}`);
