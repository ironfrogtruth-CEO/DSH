#!/usr/bin/env node
/**
 * skill-check — validate every skill in the DSH user skills root with the
 * harness's own discovery rules.
 *
 * Checks, mirroring @deepseek-ai/dsh-skill validateDefinition + isSkillName:
 *   1. SKILL.md exists with YAML frontmatter (--- ... ---)
 *   2. `name` matches /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and equals the directory name
 *   3. `description` is a non-empty string
 *   4. `content` (body after frontmatter) is non-empty
 *
 * Directory-bundle skills (<root>/<name>/SKILL.md) and flat markdown skills
 * (<root>/<name>.md) are both covered, matching the filesystem provider.
 *
 * Exit code: 0 = all valid, 1 = at least one invalid.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const REAL_HOME = join(homedir(), ".dsh");
const DSH_HOME = process.env.DSH_HOME ?? REAL_HOME;
const SKILLS_ROOT = resolve(DSH_HOME, "skills");
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The harness's yaml parser always lives in the real install; resolve it from
// there so a DSH_HOME override (used to point the skills root elsewhere) cannot
// break parsing. Bare fallback for ad-hoc environments.
let yaml;
for (const cand of [resolve(REAL_HOME, "install/node_modules/yaml"), "yaml"]) {
  try {
    yaml = require(cand);
    break;
  } catch { /* try next */ }
}
if (!yaml) {
  console.error("skill-check: cannot resolve the yaml parser from the DSH install");
  process.exit(2);
}

function parseSkill(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { errors: [`cannot read skill: ${e.message}`] };
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { errors: ["no YAML frontmatter (--- ... ---)"] };
  let fm;
  try {
    fm = yaml.parse(m[1]);
  } catch (e) {
    return { errors: [`frontmatter is not valid YAML: ${e.message}`] };
  }
  const errors = [];
  if (fm === null || typeof fm !== "object" || Array.isArray(fm))
    errors.push("frontmatter must be a YAML mapping/object");
  const body = (m[2] ?? "").trim();
  if (typeof fm?.name !== "string" || !SKILL_NAME.test(fm.name))
    errors.push(`invalid name ${JSON.stringify(fm?.name)} (need /^[a-z0-9]+(?:-[a-z0-9]+)*$/)`);
  if (typeof fm?.description !== "string" || fm.description.length === 0)
    errors.push("description must be a non-empty string");
  if (body.length === 0) errors.push("skill body is empty");
  return { fm, errors, bodyChars: body.length };
}

function collect() {
  const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  const skills = [];
  for (const e of entries) {
    const p = join(SKILLS_ROOT, e.name);
    if (e.isDirectory() && statSync(join(p, "SKILL.md"), { throwIfNoEntry: false }))
      skills.push({ key: e.name, file: join(p, "SKILL.md"), dirName: e.name });
    else if (e.isFile() && e.name.endsWith(".md"))
      skills.push({ key: e.name.replace(/\.md$/, ""), file: p, dirName: null });
  }
  return skills.sort((a, b) => a.key.localeCompare(b.key));
}

function main() {
  let skills;
  try {
    skills = collect();
  } catch (e) {
    console.error(`skill-check: cannot read ${SKILLS_ROOT}: ${e.message}`);
    process.exit(2);
  }
  if (skills.length === 0) {
    console.error(`skill-check: no skills found under ${SKILLS_ROOT}`);
    process.exit(2);
  }
  let failures = 0;
  for (const s of skills) {
    const { errors, fm, bodyChars } = parseSkill(s.file);
    const dirMatch = s.dirName === null || fm?.name === s.dirName;
    if (dirMatch === false) errors.push(`name ${JSON.stringify(fm?.name)} != directory ${JSON.stringify(s.dirName)}`);
    if (errors.length > 0) {
      failures++;
      console.log(`FAIL  ${s.key} — ${errors.join("; ")}`);
    } else {
      console.log(`PASS  ${s.key} (desc ${fm.description.length} chars, body ${bodyChars} chars)`);
    }
  }
  console.log(`\nskill-check: ${skills.length - failures}/${skills.length} skills valid${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main();
