// Runs automatically before `npm start` (Windows, macOS and Linux).
// Uses only Node built-ins, so it works even before `npm install`:
//  1. checks the Node.js version,
//  2. installs packages if any are missing (e.g. a freshly downloaded copy),
//  3. builds the web app if it hasn't been built or the source is newer.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(args, what) {
  console.log(`\n> ${what}\n`);
  // shell: true lets Windows find npm.cmd.
  const r = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) fail(`${what.replace(/ \(.*|…$/g, "")} failed. Check the messages above, then run "npm start" again.`);
}

// 1. Node version
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`Stockroom needs Node.js 22.13 or newer (you have ${process.versions.node}). Install the current LTS from https://nodejs.org and try again.`);
}

// 2. Packages
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const needed = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const missing = needed.filter((name) => !existsSync(join(root, "node_modules", ...name.split("/"), "package.json")));
if (missing.length) {
  run(["install", "--include=dev", "--no-audit", "--no-fund"], `Installing packages (first run, takes a minute or two)…`);
}

// 3. Web build
function newest(dir) {
  let t = 0;
  if (!existsSync(dir)) return t;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
const built = join(root, "dist", "index.html");
const sourceTime = Math.max(newest(join(root, "web")), newest(join(root, "shared")), statSync(join(root, "vite.config.ts")).mtimeMs);
if (!existsSync(built) || statSync(built).mtimeMs < sourceTime) {
  run(["run", "build:web"], "Building the app…");
}
