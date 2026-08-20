#!/usr/bin/env node
/**
 * Verify the non-UI seams of the local DSH Host composition.
 *
 * This is intentionally a read-only check. It does not start DSH, install
 * packages, edit profiles, or inspect/modify client bundles.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const REAL_HOME = resolve(homedir(), ".dsh");
const DEFAULT_VERSION = "0.1.0-rc.8";
const DEFAULT_CONFIG = {
  requiredDshVersion: DEFAULT_VERSION,
  extensionsRoot: "extensions",
  profilePath: "profiles/web/package.json",
  allowedHostUiBridges: [],
  warnings: {
    dangerousPermission: { enabled: true, fail: false },
    sessionSearch: { enabled: true, fail: false },
    failOnWarnings: false,
  },
};
const DEP_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const SOURCE_EXT = /\.(?:js|mjs|cjs)$/i;
const UI_FILE = /(?:^|[/\\])client\.js$|\.(?:css|tsx|jsx)$/i;
const UI_IMPORT = /\b(?:from|import|require)\b[^\n;]*["'][^"']*(?:client(?:\.js)?|\.css|\.tsx|\.jsx|dsh-client-ui|[/_-]ui[/_.-])[^"']*["']/i;

function usage() {
  return [
    "Usage:",
    "  verify-host-architecture.mjs [--root <path>] [--config <path>] [--json]",
    "      [--warnings on|off] [--fail-on-warnings]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { root: process.cwd(), config: null, format: "text", warningMode: "on", failOnWarnings: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--root") args.root = argv[++i];
    else if (token === "--config") args.config = argv[++i];
    else if (token === "--json" || token === "--format=json") args.format = "json";
    else if (token === "--format") args.format = argv[++i];
    else if (token === "--warnings") args.warningMode = argv[++i];
    else if (token === "--fail-on-warnings") args.failOnWarnings = true;
    else throw new Error(`unknown option ${token}`);
  }
  if (args.help) return args;
  if (!new Set(["text", "json"]).has(args.format)) throw new Error("--format must be text or json");
  if (!new Set(["on", "off"]).has(args.warningMode)) throw new Error("--warnings must be on or off");
  args.root = resolve(args.root);
  args.config = args.config ? resolve(args.config) : join(args.root, "architecture/fitness-functions.json");
  return args;
}

function posixPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadYamlParser(root) {
  for (const candidate of [resolve(root, "install/node_modules/yaml"), resolve(REAL_HOME, "install/node_modules/yaml"), "yaml"]) {
    try {
      return require(candidate);
    } catch {
      // Try the next known installation location.
    }
  }
  throw new Error("cannot resolve yaml parser");
}

function readYaml(root, file) {
  const yaml = loadYamlParser(root);
  return yaml.parse(readFileSync(file, "utf8"));
}

function walk(root, predicate) {
  const files = [];
  if (!existsSync(root)) return files;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") visit(join(dir, entry.name));
      else if (entry.isFile()) {
        const file = join(dir, entry.name);
        if (predicate(file)) files.push(file);
      }
    }
  }
  visit(root);
  return files;
}

function addCheck(state, id, ok, detail) {
  state.checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) state.errors.push(`${id}: ${detail}`);
}

function configFor(root, args, state) {
  let loaded = {};
  if (existsSync(args.config)) {
    try {
      loaded = readJson(args.config);
    } catch (error) {
      state.errors.push(`config: cannot read ${args.config}: ${error.message}`);
    }
  } else if (args.config !== join(root, "architecture/fitness-functions.json")) {
    state.errors.push(`config: file does not exist: ${args.config}`);
  }
  const configured = loaded.hostArchitecture ?? loaded;
  return {
    ...DEFAULT_CONFIG,
    ...configured,
    warnings: { ...DEFAULT_CONFIG.warnings, ...(configured.warnings ?? {}) },
  };
}

function checkRuntimeVersions(root, config, state) {
  const manifestFile = join(root, "container.manifest.yaml");
  const installPackageFile = join(root, "install/package.json");
  const installedFile = join(root, "install/node_modules/@deepseek-ai/dsh/package.json");
  const expected = String(config.requiredDshVersion || DEFAULT_VERSION);
  try {
    const manifest = readYaml(root, manifestFile);
    const declared = readJson(installPackageFile);
    const installed = readJson(installedFile);
    const manifestVersion = String(manifest?.runtime?.dsh ?? "");
    const installSpec = String(declared?.dependencies?.["@deepseek-ai/dsh"] ?? "");
    const installedVersion = String(installed?.version ?? "");
    const ok = manifestVersion === expected && installSpec === expected && installedVersion === expected;
    addCheck(state, "runtime-version-contract", ok, `required=${expected}, manifest=${manifestVersion || "missing"}, install=${installSpec || "missing"}, installed=${installedVersion || "missing"}`);
  } catch (error) {
    addCheck(state, "runtime-version-contract", false, error.message);
  }
}

function resolveBundle(root, profileFile, bundle, spec) {
  const profileDir = dirname(profileFile);
  if (typeof spec === "string" && spec.startsWith("link:")) {
    const target = spec.slice("link:".length);
    return resolve(target.startsWith("/") ? target : join(profileDir, target));
  }
  const candidates = [
    resolve(profileDir, "node_modules", bundle),
    resolve(root, "install/node_modules", bundle),
    resolve(root, "profiles/node_modules", bundle),
    resolve(root, "node_modules", bundle),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? candidates[0];
}

function checkProfileBundles(root, config, state) {
  const profileFile = resolve(root, config.profilePath || DEFAULT_CONFIG.profilePath);
  try {
    const profile = readJson(profileFile);
    const bundles = profile?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) {
      addCheck(state, "profile-bundle-paths", false, "profile dsh.profile.bundles is empty or missing");
      return;
    }
    const missing = [];
    const found = [];
    for (const bundle of bundles) {
      const path = resolveBundle(root, profileFile, bundle, profile?.dependencies?.[bundle]);
      if (existsSync(join(path, "package.json"))) found.push(`${bundle}=${posixPath(root, path)}`);
      else missing.push(`${bundle}=${posixPath(root, path)}`);
    }
    addCheck(state, "profile-bundle-paths", missing.length === 0, missing.length === 0 ? found.join(", ") : `missing: ${missing.join(", ")}`);
  } catch (error) {
    addCheck(state, "profile-bundle-paths", false, error.message);
  }
}

function dependencyEntries(pkg) {
  return DEP_SECTIONS.flatMap((section) => Object.entries(pkg?.[section] ?? {}).map(([name, spec]) => ({ section, name, spec })));
}

function versionSpecMatches(spec, expected) {
  return spec === expected || spec === `^${expected}` || spec === `~${expected}` || spec === `=${expected}`;
}

function checkPackageDependencies(root, config, state) {
  const extensionsRoot = resolve(root, config.extensionsRoot || DEFAULT_CONFIG.extensionsRoot);
  if (!existsSync(extensionsRoot)) {
    addCheck(state, "host-package-dependencies", false, `extensions root missing: ${posixPath(root, extensionsRoot)}`);
    return [];
  }
  const packages = [];
  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const packageFile = join(extensionsRoot, entry.name, "package.json");
    if (existsSync(packageFile)) packages.push({ dir: join(extensionsRoot, entry.name), file: packageFile, rel: posixPath(root, join(extensionsRoot, entry.name)) });
  }
  const failures = [];
  const expected = String(config.requiredDshVersion || DEFAULT_VERSION);
  for (const item of packages) {
    let pkg;
    try {
      pkg = readJson(item.file);
    } catch (error) {
      failures.push(`${item.rel}: invalid package.json (${error.message})`);
      continue;
    }
    for (const dep of dependencyEntries(pkg).filter((entry) => entry.name.startsWith("@deepseek-ai/dsh-"))) {
      if (!versionSpecMatches(String(dep.spec), expected)) failures.push(`${item.rel} ${dep.section}.${dep.name}=${dep.spec} (required ${expected})`);
      const installedFile = join(item.dir, "node_modules", dep.name, "package.json");
      if (existsSync(installedFile)) {
        try {
          const installedVersion = String(readJson(installedFile).version ?? "");
          if (installedVersion !== expected) failures.push(`${item.rel} installed ${dep.name}=${installedVersion} (required ${expected})`);
        } catch (error) {
          failures.push(`${item.rel} installed ${dep.name} unreadable (${error.message})`);
        }
      }
    }
    const lockFile = join(item.dir, "package-lock.json");
    if (existsSync(lockFile)) {
      try {
        const lock = readJson(lockFile);
        for (const dep of dependencyEntries(lock?.packages?.[""] ?? {}).filter((entry) => entry.name.startsWith("@deepseek-ai/dsh-"))) {
          if (!versionSpecMatches(String(dep.spec), expected)) failures.push(`${item.rel} lock ${dep.section}.${dep.name}=${dep.spec} (required ${expected})`);
        }
        for (const [path, node] of Object.entries(lock?.packages ?? {})) {
          if (path.startsWith("node_modules/@deepseek-ai/dsh-") && node?.version !== expected) failures.push(`${item.rel} lock ${path}=${node?.version ?? "missing"} (required ${expected})`);
        }
      } catch (error) {
        failures.push(`${item.rel}: invalid package-lock.json (${error.message})`);
      }
    }
  }
  addCheck(state, "host-package-dependencies", failures.length === 0, failures.length === 0 ? `${packages.length} local extension packages aligned to ${expected}` : failures.join("; "));
  return packages;
}

function allowedBridgeSet(config) {
  return new Set((config.allowedHostUiBridges ?? []).map((entry) => typeof entry === "string" ? entry.replace(/\/$/, "") : entry?.path).filter(Boolean));
}

function checkHostSeams(root, config, state, packages) {
  const allowed = allowedBridgeSet(config);
  const violations = [];
  for (const item of packages) {
    if (allowed.has(item.rel)) continue;
    for (const file of walk(item.dir, () => true)) {
      const rel = posixPath(root, file);
      if (UI_FILE.test(file)) violations.push(`${rel}: UI/client file in Host extension`);
      else if (SOURCE_EXT.test(file) && !/\.test\.[^.]+$|\.bak(?:[-.]|$)/i.test(file)) {
        let source;
        try { source = readFileSync(file, "utf8"); } catch { continue; }
        if (UI_IMPORT.test(source)) violations.push(`${rel}: imports client/UI/CSS surface`);
      }
    }
    try {
      const pkg = readJson(item.file);
      const metadata = [...(Array.isArray(pkg.files) ? pkg.files : []), ...Object.keys(pkg.exports ?? {}), ...Object.values(pkg.exports ?? {})];
      if (metadata.some((value) => typeof value === "string" && UI_FILE.test(value))) violations.push(`${item.rel}/package.json: publishes client/UI file`);
    } catch {
      // Package JSON errors are reported by the dependency check.
    }
  }
  addCheck(state, "host-plugin-seams", violations.length === 0, violations.length === 0 ? `no UI seam violations (${allowed.size} explicit bridge exceptions)` : violations.join("; "));
}

function warning(state, code, message) {
  state.warnings.push({ code, message, severity: "warning" });
}

function checkWarnings(root, config, args, state) {
  if (args.warningMode === "off") return;
  const warningConfig = config.warnings ?? {};
  if (warningConfig.dangerousPermission?.enabled !== false) {
    const candidates = [join(root, "settings.yaml"), join(root, "container.manifest.yaml")].filter(existsSync);
    if (candidates.some((file) => /danger-full-access/i.test(readFileSync(file, "utf8")))) warning(state, "DANGEROUS_PERMISSION", "danger-full-access appears in runtime configuration");
  }
  if (warningConfig.sessionSearch?.enabled !== false) {
    const candidates = [join(root, "profiles/web/cordis.patch.yml"), join(root, "install/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml")].filter(existsSync);
    const disabled = candidates.some((file) => /openAt:\s*never/i.test(readFileSync(file, "utf8")));
    if (disabled) warning(state, "SESSION_SEARCH_DISABLED", "full-text session search is configured with openAt: never");
    else if (candidates.length === 0) warning(state, "SESSION_SEARCH_UNVERIFIED", "no session-search configuration source was found");
  }
}

function printResult(result, format) {
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else {
    for (const check of result.checks) console.log(`${check.status === "pass" ? "PASS" : "FAIL"} ${check.id} — ${check.detail}`);
    for (const item of result.warnings) console.log(`WARN ${item.code} — ${item.message}`);
    for (const error of result.errors) console.log(`ERROR ${error}`);
    console.log(`${result.ok ? "PASS" : "FAIL"} host-architecture: ${result.summary}`);
  }
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
  const state = { checks: [], errors: [], warnings: [] };
  const config = configFor(args.root, args, state);
  checkRuntimeVersions(args.root, config, state);
  checkProfileBundles(args.root, config, state);
  const packages = checkPackageDependencies(args.root, config, state);
  checkHostSeams(args.root, config, state, packages);
  checkWarnings(args.root, config, args, state);
  const configFail = config.warnings?.failOnWarnings === true;
  const failOnWarnings = args.failOnWarnings || configFail || Object.values(config.warnings ?? {}).some((item) => item && typeof item === "object" && item.fail === true);
  const ok = state.errors.length === 0 && (!failOnWarnings || state.warnings.length === 0);
  const result = {
    schemaVersion: 1,
    root: args.root,
    requiredDshVersion: String(config.requiredDshVersion || DEFAULT_VERSION),
    ok,
    checks: state.checks,
    warnings: state.warnings,
    errors: state.errors,
    summary: `${state.checks.filter((check) => check.status === "pass").length}/${state.checks.length} checks passed, ${state.errors.length} errors, ${state.warnings.length} warnings`,
  };
  printResult(result, args.format);
  process.exitCode = ok ? 0 : 1;
}

main();
