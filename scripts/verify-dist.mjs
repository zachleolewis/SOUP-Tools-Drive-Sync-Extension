// After the build: the release assets exist, the manifest is valid for SOUP, and main.js is a plain ES module that reads
// `soup`/`react` from SOUP (no bare imports, no eval).
import { existsSync, readFileSync } from "node:fs";

const fail = (m) => {
  console.error(`verify-dist: ${m}`);
  process.exit(1);
};
for (const f of ["manifest.json", "main.js"]) if (!existsSync(`dist/${f}`)) fail(`dist/${f} is missing`);
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.id !== "drive-sync") fail(`manifest id is ${manifest.id}`);
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} != package version ${pkg.version}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail("manifest version is not x.y.z");
if (manifest.minAppVersion !== "2.3.0") fail("minAppVersion should be 2.3.0");
for (const u of ["accounts", "network"]) if (!manifest.uses?.includes(u)) fail(`manifest.uses must include ${u}`);
if (manifest.author !== "zachleolewis") fail("author must be zachleolewis");
if (!manifest.links?.length) fail("manifest.links is empty");
const main = readFileSync("dist/main.js", "utf8");
if (/^\s*import\s[^;]*from\s+["'](?!\.)/m.test(main)) fail("main.js has a bare import (everything must be bundled or provided by SOUP)");
if (/\beval\s*\(|new Function\s*\(/.test(main)) fail("main.js uses eval/new Function");
if (!/export\s*\{[^}]*default/.test(main) && !/export default/.test(main)) fail("main.js has no default export");
// The scopes are a promise: nothing broader than drive.file may appear in the shipped code.
const scopes = [...new Set(main.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? [])];
const allowed = new Set(["https://www.googleapis.com/auth/drive.file"]);
const extra = scopes.filter((s) => !allowed.has(s));
if (extra.length) fail(`main.js mentions other Google scopes: ${extra.join(", ")}`);
// A release must carry the real Google client, not the placeholders of an unconfigured build.
const configured = !main.includes("unconfigured.apps.googleusercontent.com");
if (process.argv.includes("--release") && (!configured || !/"\d+-[a-z0-9]+\.apps\.googleusercontent\.com"/.test(main)))
  fail("main.js has no Google client: set DRIVE_SYNC_CLIENT_ID and DRIVE_SYNC_CLIENT_SECRET (release secrets) or google-oauth-client.json");
if (!configured) console.log("verify-dist: note: built without the Google client (placeholders); sign-in will not work in this build");
console.log(`verify-dist: ok (${manifest.id} ${manifest.version}, main.js ${(main.length / 1024).toFixed(0)} KB${existsSync("dist/styles.css") ? ", styles.css" : ""})`);
