#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "dsh-host-architecture-"));
const script = join(process.cwd(), "scripts/verify-host-architecture.mjs");

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(...extraArgs) {
  return spawnSync(process.execPath, [script, "--root", root, ...extraArgs, "--json"], { encoding: "utf8" });
}

try {
  mkdirSync(join(root, "install/node_modules/@deepseek-ai/dsh"), { recursive: true });
  mkdirSync(join(root, "profiles/web"), { recursive: true });
  mkdirSync(join(root, "extensions/good-host/node_modules/@deepseek-ai/dsh-tools"), { recursive: true });
  writeFileSync(join(root, "container.manifest.yaml"), "runtime:\n  dsh: 0.1.0-rc.8\n");
  writeJson(join(root, "install/package.json"), { dependencies: { "@deepseek-ai/dsh": "0.1.0-rc.8" } });
  writeJson(join(root, "install/node_modules/@deepseek-ai/dsh/package.json"), { name: "@deepseek-ai/dsh", version: "0.1.0-rc.8" });
  writeJson(join(root, "profiles/web/package.json"), {
    dependencies: { "@local/good-host": "link:../../extensions/good-host" },
    dsh: { profile: { bundles: ["@local/good-host"] } },
  });
  writeJson(join(root, "extensions/good-host/package.json"), {
    name: "@local/good-host",
    dependencies: { "@deepseek-ai/dsh-tools": "^0.1.0-rc.8" },
  });
  writeJson(join(root, "extensions/good-host/node_modules/@deepseek-ai/dsh-tools/package.json"), {
    name: "@deepseek-ai/dsh-tools",
    version: "0.1.0-rc.8",
  });
  writeFileSync(join(root, "extensions/good-host/index.js"), "export const name = 'good-host'\n");

  const pass = run("--warnings", "off");
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.equal(JSON.parse(pass.stdout).ok, true);

  writeFileSync(join(root, "settings.yaml"), "permission:\n  defaultPreset: danger-full-access\n");
  writeFileSync(join(root, "profiles/web/cordis.patch.yml"), "sessionSearch:\n  openAt: never\n");
  const warnings = run();
  assert.equal(warnings.status, 0, warnings.stderr || warnings.stdout);
  assert.deepEqual(JSON.parse(warnings.stdout).warnings.map((item) => item.code), ["DANGEROUS_PERMISSION", "SESSION_SEARCH_DISABLED"]);
  const strictWarnings = run("--fail-on-warnings");
  assert.equal(strictWarnings.status, 1, strictWarnings.stderr || strictWarnings.stdout);

  writeJson(join(root, "extensions/good-host/package.json"), {
    name: "@local/good-host",
    dependencies: { "@deepseek-ai/dsh-tools": "^0.1.0-rc.6" },
  });
  const drift = run();
  assert.equal(drift.status, 1, drift.stderr || drift.stdout);
  assert.match(JSON.parse(drift.stdout).errors.join("\n"), /rc\.6/);

  writeJson(join(root, "extensions/good-host/package.json"), {
    name: "@local/good-host",
    dependencies: { "@deepseek-ai/dsh-tools": "^0.1.0-rc.8" },
  });
  mkdirSync(join(root, "extensions/new-host"), { recursive: true });
  writeJson(join(root, "extensions/new-host/package.json"), { name: "@local/new-host" });
  writeFileSync(join(root, "extensions/new-host/client.js"), "export const forbidden = true\n");
  const seam = run();
  assert.equal(seam.status, 1, seam.stderr || seam.stdout);
  assert.match(JSON.parse(seam.stdout).errors.join("\n"), /new-host\/client\.js/);
  console.log("verify-host-architecture.test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
