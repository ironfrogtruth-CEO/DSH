#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "dsh-ui-integrity-"));
const manifest = join(root, "architecture", "ui-baseline.json");
const script = join(process.cwd(), "scripts/verify-ui-integrity.mjs");

function run(mode) {
  return spawnSync(process.execPath, [script, mode, "--root", root, "--manifest", manifest, "--json"], {
    encoding: "utf8",
  });
}

try {
  mkdirSync(join(root, "apps"), { recursive: true });
  mkdirSync(join(root, "extensions/demo"), { recursive: true });
  mkdirSync(join(root, "custom-ui-patches/demo"), { recursive: true });
  writeFileSync(join(root, "apps/大神.swift"), "let ui = 1\n");
  writeFileSync(join(root, "extensions/demo/client.js"), "export const version = 1\n");
  writeFileSync(join(root, "custom-ui-patches/demo/panel.js.modified"), "const panel = 1\n");

  const recorded = run("record");
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  assert.equal(JSON.parse(recorded.stdout).files, 3);
  const clean = run("check");
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.equal(JSON.parse(clean.stdout).ok, true);

  writeFileSync(join(root, "extensions/demo/client.js"), "export const version = 2\n");
  writeFileSync(join(root, "custom-ui-patches/demo/new.css"), ".new { color: red }\n");
  const drift = run("check");
  assert.equal(drift.status, 1, drift.stderr || drift.stdout);
  const driftResult = JSON.parse(drift.stdout);
  assert.deepEqual(driftResult.added, ["custom-ui-patches/demo/new.css"]);
  assert.equal(driftResult.changed[0].path, "extensions/demo/client.js");
  console.log("verify-ui-integrity.test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
