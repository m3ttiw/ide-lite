// Writes the static update manifest (latest.json) read by tauri-plugin-updater
// from https://github.com/<repo>/releases/latest/download/latest.json.
//
//   node scripts/updater-manifest.mjs --dir <bundle/nsis> --tag vX.Y.Z --repo owner/name [--out latest.json]
//
// It expects exactly one `<name>_<version>_x64-setup.exe` and its `.sig` in --dir
// (Tauri writes the `.sig` when TAURI_SIGNING_PRIVATE_KEY is set and
// bundle.createUpdaterArtifacts is true). Release notes are taken from the
// CHANGELOG.md section of that version, when there is one.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const dir = resolve(args.dir ?? join(root, "src-tauri", "target", "release", "bundle", "nsis"));
const tag = args.tag || process.env.GITHUB_REF_NAME || "";
const repo = args.repo || process.env.GITHUB_REPOSITORY || "m3ttiw/ide-lite";
const out = resolve(args.out ?? join(dir, "latest.json"));

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (tag !== `v${version}`) fail(`Tag ${JSON.stringify(tag)} does not match package version v${version}`);

const installers = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(`_${version}_x64-setup.exe`)) : [];
if (installers.length !== 1) fail(`Expected one *_${version}_x64-setup.exe in ${dir}, found ${installers.length}`);
const installer = installers[0];
const sigPath = join(dir, `${installer}.sig`);
if (!existsSync(sigPath)) fail(`Missing signature ${sigPath}: was TAURI_SIGNING_PRIVATE_KEY set?`);
const signature = readFileSync(sigPath, "utf8").trim();
if (!signature) fail(`Empty signature ${sigPath}`);

function changelogNotes(v) {
  const file = join(root, "CHANGELOG.md");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const escaped = v.replace(/\./g, "\\.");
  const start = lines.findIndex((l) => new RegExp(`^#{1,3} \\[?${escaped}\\]?(\\W|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} \[?\d+\.\d+\.\d+/.test(l));
  if (end < 0) end = lines.length;
  const text = lines.slice(start + 1, end).join("\n").trim();
  return text || null;
}

const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installer)}`;
const platform = { signature, url };
const manifest = {
  version,
  notes: changelogNotes(version) ?? "",
  pub_date: new Date().toISOString(),
  // The plugin looks for "<os>-<arch>-<installer>" first, then "<os>-<arch>".
  platforms: { "windows-x86_64-nsis": platform, "windows-x86_64": platform },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} for ${basename(installer)} (${tag})`);
