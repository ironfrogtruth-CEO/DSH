#!/usr/bin/env node
/**
 * session-audit — aggregate delivery-quality and efficiency metrics from DSH
 * session logs WITHOUT reading conversation content.
 *
 * Reads session logs under the DSH sessions root (zstd-compressed JSONL),
 * extracts only structured fields (event types, tool names, exit codes,
 * timestamps, counts). Never prints message bodies, tool arguments or any
 * content that could contain credentials.
 *
 * Metrics per session:
 *   turns, steps, user messages, tool calls (by name), skill loads (which),
 *   bash failures ([exit code: N] non-zero / [sandbox: denials), rework
 *   (consecutive identical tool calls), reasoning/text chunk volume,
 *   duration (first event -> last event).
 *
 * Usage:
 *   node session-audit.mjs                    # all sessions, per-session table
 *   node session-audit.mjs --cutoff <epochMs> # two-period aggregate around cutoff
 *   node session-audit.mjs --json             # machine-readable JSON
 *   node session-audit.mjs --until <epochMs>  # only sessions started before
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const REASONING = new Set(["reasoning-chunks"]);
const TEXT_CHUNKS = new Set(["text-chunks", "assistant/chunk"]);
const TOOL_FAIL = /\[exit code: [1-9]\d*\]|\[sandbox: .*denied/;
const SKILL_LOAD_TOOLS = new Set(["skill", "mcp__playwright__browser_snapshot"]);

function readArgs() {
  const a = process.argv.slice(2);
  const o = { cutoff: null, until: null, json: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--cutoff") o.cutoff = Number(a[i + 1]);
    else if (a[i] === "--until") o.until = Number(a[i + 1]);
    else if (a[i] === "--json") o.json = true;
  }
  return o;
}

function decompress(file) {
  return execFileSync("zstd", ["-dc", file], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
}

function parseSkillArg(arg) {
  try {
    const o = JSON.parse(arg);
    return o.name;
  } catch {
    return null;
  }
}

function auditSession(file) {
  const s = { file, id: file.split("/").slice(-2)[0], calls: {}, skills: {}, failures: 0, rework: 0, turns: 0, steps: 0, users: 0, reasoning: 0, text: 0, toolCalls: 0, first: null, last: null, createdAt: null, preset: null, cwd: null };
  let prevKey = null;
  let prevArg = null;
  try {
    for (const line of decompress(file).split("\n")) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const t = o.type;
      const time = o.time ?? o.createdAt;
      if (typeof time === "number") {
        if (s.first === null || time < s.first) s.first = time;
        if (s.last === null || time > s.last) s.last = time;
      }
      if (t === "session") { s.createdAt = o.createdAt; s.preset = o.agentPreset; s.cwd = o.cwd; continue; }
      if (t === "turn/start") { s.turns++; continue; }
      if (t === "step/start") { s.steps++; continue; }
      if (t === "user/message") { s.users++; continue; }
      if (REASONING.has(t)) { s.reasoning++; continue; }
      if (TEXT_CHUNKS.has(t)) { s.text++; continue; }
      if (t === "tool/call") {
        const d = o.data ?? {};
        const name = d.name ?? "?";
        s.toolCalls++;
        s.calls[name] = (s.calls[name] ?? 0) + 1;
        if (name === "skill") {
          const skill = parseSkillArg(d.arguments);
          if (skill) s.skills[skill] = (s.skills[skill] ?? 0) + 1;
        }
        const arg = String(d.arguments ?? "");
        if (prevKey === name && prevArg === arg) s.rework++;
        prevKey = name; prevArg = arg;
        continue;
      }
      if (t === "tool/result") {
        const ser = JSON.stringify(o.data ?? "");
        if (TOOL_FAIL.test(ser)) s.failures++;
      }
    }
  } catch { /* unreadable log: keep what we have */ }
  return s;
}

function collect(opts) {
  const out = [];
  for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    for (const sid of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
      if (!sid.isDirectory()) continue;
      const f = join(SESSIONS_ROOT, ws.name, sid.name, "session.jsonl.zstd");
      const s = auditSession(f);
      if (opts.until !== null && s.createdAt !== null && s.createdAt > opts.until) continue;
      out.push(s);
    }
  }
  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function aggregate(list) {
  const a = { sessions: list.length, turns: 0, steps: 0, users: 0, toolCalls: 0, failures: 0, rework: 0, reasoning: 0, text: 0, skills: {}, calls: {} };
  for (const s of list) {
    a.turns += s.turns; a.steps += s.steps; a.users += s.users;
    a.toolCalls += s.toolCalls; a.failures += s.failures; a.rework += s.rework;
    a.reasoning += s.reasoning; a.text += s.text;
    for (const [k, v] of Object.entries(s.skills)) a.skills[k] = (a.skills[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.calls)) a.calls[k] = (a.calls[k] ?? 0) + v;
  }
  return a;
}

function fmtRow(s) {
  const durMin = s.first && s.last ? ((s.last - s.first) / 60000).toFixed(1) : "-";
  const fRate = s.toolCalls ? ((s.failures / s.toolCalls) * 100).toFixed(1) + "%" : "-";
  return `${new Date(s.createdAt ?? s.first ?? 0).toISOString().slice(0, 16)}  turns=${s.turns} steps=${s.steps} calls=${s.toolCalls} fail=${s.failures}(${fRate}) rework=${s.rework} skills=${Object.keys(s.skills).join(",") || "-"} ${durMin}min`;
}

function main() {
  const opts = readArgs();
  const all = collect(opts);
  if (all.length === 0) { console.log("session-audit: no sessions found"); process.exit(0); }
  if (opts.json) {
    const payload = { cutoff: opts.cutoff ?? null, sessions: all.map((s) => ({ id: s.id, cwd: s.cwd, preset: s.preset, createdAt: s.createdAt, turns: s.turns, steps: s.steps, users: s.users, toolCalls: s.toolCalls, failures: s.failures, rework: s.rework, reasoning: s.reasoning, text: s.text, skills: s.skills, calls: s.calls, durationMs: s.first && s.last ? s.last - s.first : null })) };
    console.log(JSON.stringify(payload, null, 1));
    return;
  }
  if (opts.cutoff !== null) {
    const before = aggregate(all.filter((s) => (s.createdAt ?? 0) < opts.cutoff));
    const after = aggregate(all.filter((s) => (s.createdAt ?? 0) >= opts.cutoff));
    const line = (label, a) => `${label}: sessions=${a.sessions} turns=${a.turns} steps=${a.steps} calls=${a.toolCalls} failures=${a.failures} failRate=${a.toolCalls ? ((a.failures / a.toolCalls) * 100).toFixed(1) + "%" : "-"} rework=${a.rework} reasoningChunks=${a.reasoning} skillsLoaded=${Object.values(a.skills).reduce((x, y) => x + y, 0)} skillSet=${Object.keys(a.skills).join(",") || "-"}`;
    console.log(`== BEFORE cutoff ${new Date(opts.cutoff).toISOString()} ==`); console.log(line("before", before));
    console.log(`== AFTER cutoff ==`); console.log(line("after", after));
    return;
  }
  console.log(`== ${all.length} sessions ==`);
  for (const s of all) console.log(fmtRow(s));
}

main();
