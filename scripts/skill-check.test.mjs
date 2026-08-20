#!/usr/bin/env node
/** Focused regression test for skill-check's per-file failure reporting. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testRoot = mkdtempSync(join(tmpdir(), "dsh-skill-check-"));
const skillsRoot = join(testRoot, "skills");
const script = join(dirname(fileURLToPath(import.meta.url)), "skill-check.mjs");

function addSkill(name, content) {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

try {
  addSkill("valid-skill", "---\nname: valid-skill\ndescription: valid\n---\nbody\n");
  addSkill("no-frontmatter", "# missing frontmatter\n");
  addSkill("bad-frontmatter", "---\nname: [unterminated\ndescription: broken\n---\nbody\n");
  addSkill("scalar-frontmatter", "---\njust-a-scalar\n---\nbody\n");

  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, DSH_HOME: testRoot },
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /PASS\s+valid-skill/);
  assert.match(output, /FAIL\s+no-frontmatter/);
  assert.match(output, /FAIL\s+bad-frontmatter/);
  assert.match(output, /FAIL\s+scalar-frontmatter/);
  assert.match(output, /skill-check: 1\/4 skills valid, 3 FAILED/);
  assert.doesNotMatch(output, /TypeError|Unhandled|SyntaxError/);
  console.log("skill-check.test: PASS");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
