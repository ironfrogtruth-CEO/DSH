#!/usr/bin/env node
/**
 * Protect the checked-in UI surface without changing it.
 *
 * Usage:
 *   node scripts/verify-ui-integrity.mjs record --manifest <path> [--root <path>]
 *   node scripts/verify-ui-integrity.mjs check  --manifest <path> [--root <path>]
 *
 * The manifest path is deliberately required. A caller must choose where a
 * baseline lives; this tool never guesses or overwrites a formal baseline by
 * itself. Paths in the manifest are root-relative POSIX paths and each file
 * has a SHA-256 digest.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const UI_EXTENSIONS = /\.(?:js|css|tsx|jsx)(?:\.[^/\\]+)?$/i;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function usage() {
  return [
    "Usage:",
    "  verify-ui-integrity.mjs record --manifest <path> [--root <path>] [--json]",
    "  verify-ui-integrity.mjs check  --manifest <path> [--root <path>] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { mode: null, manifest: null, root: process.cwd(), format: "text" };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--manifest") {
      args.manifest = argv[++i];
    } else if (token === "--root") {
      args.root = argv[++i];
    } else if (token === "--json" || token === "--format=json") {
      args.format = "json";
    } else if (token === "--format") {
      args.format = argv[++i];
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option ${token}`);
    } else {
      positional.push(token);
    }
  }
  args.mode = positional[0] ?? null;
  if (args.help) return args;
  if (!new Set(["record", "check"]).has(args.mode)) throw new Error("mode must be record or check");
  if (!args.manifest) throw new Error("--manifest is required; no baseline path is hard-coded");
  if (!new Set(["text", "json"]).has(args.format)) throw new Error("--format must be text or json");
  args.root = resolve(args.root);
  args.manifest = resolve(args.manifest);
  return args;
}

function rootRelative(root, file) {
  return relative(root, file).split(sep).join("/");
}

function walk(root, predicate) {
  const files = [];
  if (!existsSync(root)) return files;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        const file = join(dir, entry.name);
        if (predicate(file)) files.push(file);
      }
    }
  }
  visit(root);
  return files;
}

function discoverProtectedFiles(root) {
  const files = [];
  const apps = join(root, "apps");
  if (existsSync(apps)) {
    for (const entry of readdirSync(apps, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".swift") files.push(join(apps, entry.name));
    }
  }
  files.push(...walk(join(root, "extensions"), (file) => basename(file) === "client.js"));
  files.push(...walk(join(root, "custom-ui-patches"), (file) => UI_EXTENSIONS.test(basename(file))));
  return [...new Set(files)].sort((a, b) => rootRelative(root, a).localeCompare(rootRelative(root, b)));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function scan(root) {
  const files = discoverProtectedFiles(root);
  const entries = [];
  const errors = [];
  for (const file of files) {
    try {
      entries.push({ path: rootRelative(root, file), sha256: sha256(file) });
    } catch (error) {
      errors.push(`cannot hash ${rootRelative(root, file)}: ${error.message}`);
    }
  }
  return { entries, errors };
}

function printResult(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const item of result.added ?? []) console.log(`ADDED   ${item}`);
  for (const item of result.missing ?? []) console.log(`MISSING ${item}`);
  for (const item of result.changed ?? []) console.log(`CHANGED ${item.path}`);
  for (const item of result.errors ?? []) console.log(`ERROR   ${item}`);
  const state = result.ok ? "PASS" : "FAIL";
  console.log(`${state} ui-integrity: ${result.summary}`);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest must be a JSON object");
  if (!Array.isArray(manifest.files)) throw new Error("manifest.files must be an array");
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") throw new Error("manifest file entries require path and sha256");
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error(`manifest path must be root-relative: ${entry.path}`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`invalid sha256 for ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`duplicate manifest path: ${entry.path}`);
    seen.add(entry.path);
  }
}

function record(args) {
  const scanResult = scan(args.root);
  if (scanResult.errors.length > 0) {
    return { ok: false, mode: "record", errors: scanResult.errors, summary: "unable to hash protected files" };
  }
  const manifest = {
    schemaVersion: 1,
    root: ".",
    protectedPatterns: ["apps/*.swift", "extensions/**/client.js", "custom-ui-patches/**/*.{js,css,tsx,jsx}"],
    files: scanResult.entries,
  };
  mkdirSync(dirname(args.manifest), { recursive: true });
  writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ok: true, mode: "record", manifest: args.manifest, files: scanResult.entries.length, summary: `recorded ${scanResult.entries.length} protected files` };
}

function check(args) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
    validateManifest(manifest);
  } catch (error) {
    return { ok: false, mode: "check", errors: [`cannot read manifest: ${error.message}`], added: [], missing: [], changed: [], summary: "invalid or unreadable manifest" };
  }
  const scanResult = scan(args.root);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  const current = new Map(scanResult.entries.map((entry) => [entry.path, entry.sha256]));
  const added = [...current.keys()].filter((path) => !expected.has(path)).sort();
  const missing = [...expected.keys()].filter((path) => !current.has(path)).sort();
  const changed = [...current.keys()]
    .filter((path) => expected.has(path) && expected.get(path) !== current.get(path))
    .sort()
    .map((path) => ({ path, expected: expected.get(path), actual: current.get(path) }));
  const errors = [...scanResult.errors];
  const ok = added.length === 0 && missing.length === 0 && changed.length === 0 && errors.length === 0;
  return { ok, mode: "check", manifest: args.manifest, added, missing, changed, errors, summary: ok ? `all ${current.size} protected files match` : `${added.length} added, ${missing.length} missing, ${changed.length} changed` };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const result = args.mode === "record" ? record(args) : check(args);
  printResult(result, args.format);
  process.exitCode = result.ok ? 0 : 1;
}

main();
