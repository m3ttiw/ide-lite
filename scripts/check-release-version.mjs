// Release gate: package.json holds a valid SemVer version, Tauri reads its
// version from package.json, and (when a tag is given) the tag is v<version>.
//
//   node scripts/check-release-version.mjs [vX.Y.Z]
//   GITHUB_REF_NAME=vX.Y.Z node scripts/check-release-version.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? "")) {
  fail(`Invalid semantic version in package.json: ${pkg.version}`);
}
if (tauri.version !== "../package.json") {
  fail(`src-tauri/tauri.conf.json must take its version from package.json ("version": "../package.json"), found ${JSON.stringify(tauri.version)}`);
}
if (tag && tag !== `v${pkg.version}`) {
  fail(`Release tag ${tag} does not match package version v${pkg.version}`);
}
console.log(`Release version validated: v${pkg.version}${tag ? ` (tag ${tag})` : ""}`);
