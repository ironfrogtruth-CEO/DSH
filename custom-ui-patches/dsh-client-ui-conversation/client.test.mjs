import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const patchUrl = new URL('./client.js.modified', import.meta.url)
const installedUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url)

test('conversation patch keeps only native shrimp task tabs and fails stale views closed to chat', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched)
  assert.match(patched, /new Set\(\["chat", "shrimp-catch", "shrimp-library"(?:, "[^"]+")*\]\)/)
  assert.match(patched, /new Set\(\[\.\.\.PRIMARY_VIEW_IDS, "trajectory"\]\)/)
  assert.match(patched, /ACTIVE_VIEW_IDS\.has\(selectedId \?\? ""\) \? selectedId : DEFAULT_VIEW_ID/)
  assert.match(patched, /allViews\(\)\.filter\(\(view\) => PRIMARY_VIEW_IDS\.has\(view\.id\)\)/)
  assert.match(patched, /let activeHeaderSessionId = null/)
  assert.match(patched, /const sessionChanged = activeHeaderSessionId !== sessionId/)
  assert.match(patched, /if \(sessionChanged && currentView !== DEFAULT_VIEW_ID\) actions\.setView\(DEFAULT_VIEW_ID\)/)
})

test('conversation patch keeps context events durable but out of the chat publication', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched)
  assert.match(
    patched,
    /buildViewNode: \(context\) => \{\n\s*if \(context\.state === void 0 \|\| context\.state\.kind === "context"\) return null;\n\s*return chatNode\(context, context\.state\.kind, context\.state\.seq, context\.state\);/
  )
  assert.match(patched, /if \(event\.data\.source\.kind !== "user"\) return \{\n\s*kind: "context"/)
  assert.match(patched, /ctx\.conversationEvents\.register\(messageDefinition\)/)
  assert.match(patched, /key: "assistant-step"/)
  assert.match(patched, /kind: "tool-call"/)
  assert.match(patched, /registerToolConversationNode\(ctx\)/)
  assert.match(patched, /key: "context"/)
})

test('conversation flow projects durable child lifecycle into clickable Marvel status pills', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched)
  assert.match(patched, /function SubagentStatusRail\(\{ sessionId, useSessions, openSubagent \}\)/)
  assert.match(patched, /summary\.origin === "subagent" && summary\.parentId === sessionId/)
  assert.match(patched, /projectionValues\?\.subagent/)
  assert.match(patched, /function subagentPersonaOf\(summary, entry\)/)
  assert.match(patched, /奇异博士·研究-01 检查 settings\.yaml/)
  assert.match(patched, /return `\$\{hero\}·\$\{role\}\$\{task\.slice\(role\.length\)\}`/)
  assert.match(patched, /children: label/)
  assert.match(patched, /data-subagent-status-rail/)
  assert.match(patched, /"data-child-session-id": id/)
  assert.match(patched, /已开始工作/)
  assert.match(patched, /已完成/)
  assert.match(patched, /已中断/)
  assert.match(patched, /openSubagent: \(address\) => \{/)
  assert.match(patched, /sessions\.openSubagent\(retained \?\? address\)/)
  assert.match(patched, /SubagentStatusRail, \{\n\s*sessionId,\n\s*useSessions,\n\s*openSubagent/)
})
