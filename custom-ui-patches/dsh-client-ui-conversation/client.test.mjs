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

test('remote-channel security envelope remains durable but chat renders only the task text', async () => {
  const source = await readFile(patchUrl, 'utf8')
  assert.match(source, /function projectRemoteTaskContent\(content\)/)
  assert.match(source, /\[BEGIN UNTRUSTED REMOTE TASK\]/)
  assert.match(source, /--- remote task text ---\\s\*\(\[\\s\\S\]\*\?\)\\s\*--- end remote task text ---/)
  assert.match(source, /content: projectRemoteTaskContent\(data\.content\)/)
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

test('conversation exposes a formal session run-status seat above the active chat view', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])
  assert.equal(installed, patched)
  assert.match(patched, /"conversation\.session\.run-status": \{\n\s*kind: "single",\n\s*scope: "session"\n\s*\}/)
  assert.match(patched, /renderSlot\("conversation\.session\.run-status", \{\}\)/)
  assert.ok(patched.indexOf('renderSlot("conversation.session.run-status", {})') > patched.indexOf('function ConversationSession'))
})

test('ordinary todo projection renders the CyberMarcus plan strip with a visible running step', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched)
  assert.match(patched, /const CYBERMARCUS_BRAND = "CyberMarcus"/)
  assert.match(patched, /const taskTitle = useSessions\(\(s\) => \{\n\s*const summary = sessionId === void 0 \? void 0 : s\.byId\[sessionId\];\n\s*return summary\?\.displayTitle \?\? summary\?\.title;/)
  assert.match(patched, /taskTitle\n\s*\};/)
  assert.match(patched, /function cleanTaskTitle\(value\)/)
  assert.match(patched, /title = title\.replace\(\/\^CyberMarcus/)
  assert.match(patched, /Array\.from\(title\)\.slice\(0, 10\)\.join\(""\)/)
  assert.match(patched, /function resolvedTaskTitle\(todos, summaryTitle\)/)
  assert.match(patched, /function planProgressPercent\(todos\)/)
  assert.match(patched, /Math\.round\(done \/ todos\.length \* 100\)/)
  assert.match(patched, /className: "dshCyberPlan_taskRow"/)
  assert.match(patched, /"data-task-row": ""/)
  const headerStart = patched.indexOf('className: TodoPanel_module_css_default.header')
  const taskRowStart = patched.indexOf('"data-task-row": ""')
  assert.ok(headerStart >= 0 && taskRowStart > headerStart)
  assert.equal(patched.slice(headerStart, taskRowStart).includes('data-task-title-label'), false)
  assert.match(patched, /className: "dshCyberPlan_taskLabel",\n\s*"data-task-title-label": ""/)
  assert.match(patched, /className: "dshCyberPlan_taskStatus"/)
  assert.match(patched, /function compactTodoItems\(todos\)/)
  assert.match(patched, /item\.status === "in_progress" \? \[index\] : \[\]/)
  assert.match(patched, /"aria-current": entry\.item\.status === "in_progress" \? "step" : void 0/)
  assert.match(patched, /dshCyberPlan_item\[data-status=in_progress\]\{[^}]*border:1\.5px solid var\(--dsw-alias-state-business-primary\)/)
  assert.match(patched, /dshCyberPlan_item\[data-status=in_progress\] \.dshCyberPlan_dot\{[^}]*box-shadow/)
  assert.match(patched, /dshCyberPlan_item\[data-status=in_progress\]\{[^}]*animation:dsh-cyber-plan-highlight 2s ease-in-out infinite/)
  assert.match(patched, /dshCyberPlan_item\[data-status=in_progress\] \.dshCyberPlan_dot\{[^}]*animation:dsh-cyber-plan-pulse 1\.8s ease-in-out infinite/)
  assert.match(patched, /@keyframes dsh-cyber-plan-highlight/)
  assert.match(patched, /@keyframes dsh-cyber-plan-pulse/)
  assert.match(patched, /className: "dshCyberPlan_progressTrack"/)
  assert.match(patched, /role: "progressbar"/)
  assert.match(patched, /"aria-valuenow": completion/)
  assert.match(patched, /className: "dshCyberPlan_progressFill"/)
  assert.match(patched, /style: \{ width: `\$\{completion\}%` \}/)
  assert.match(patched, /dshCyberPlan_progressTrack\{[^}]*height:4px/)
  assert.match(patched, /dshCyberPlan_progressFill\{[^}]*transition:width \.2s ease/)
  assert.match(patched, /const COMPOSER_WORKBENCH_EVENT = "dsh:composer-workbench"/)
  assert.match(patched, /document\.querySelector\("\.dsh-shrimp-tank-card"\)/)
  assert.match(patched, /detail: \{ panel: "plan" \}/)
  assert.match(patched, /dshCyberPlan_item\{[^}]*flex:0 0 110px;min-width:100px;min-height:50px/)
  assert.match(patched, /dshCyberPlan_item\{[^}]*border-block-start-color:var\(--dsw-alias-border-l2\)/)
  assert.match(patched, /dshCyberPlan_stepLabel\{[^}]*flex-direction:column/)
  assert.match(patched, /dshCyberPlan_ellipsis\{[^}]*flex:0 0 18px;min-width:18px;min-height:50px;border:0/)
  assert.match(patched, /:has\(\.dshCyberPlan_root\):has\(\.dsh-shrimp-tank-card\)[^{]*\.dshCyberPlan_taskRow/)
  assert.match(patched, /:has\(\.dshCyberPlan_root\):has\(\.dsh-shrimp-tank-card\)[^{]*\.dsh-shrimp-tank-card\{[^}]*border-radius:0/)
  assert.match(patched, /className: "dshCyberPlan_stepLabel"/)
  assert.match(patched, /children: `\$\{entry\.index \+ 1\} · \$\{todoStatusLabel/)
  assert.match(patched, /dshCyberPlan_list\{[^}]*display:flex/)
  assert.match(patched, /dshCyberPlan_root\{[^}]*margin:0 auto calc\(var\(--dsh-composer-stack-gap,6px\) \* -1\)/)
  assert.match(patched, /dshCyberPlan_root\{[^}]*border-block-end-color:transparent/)
  assert.match(patched, /dshCyberPlan_root\{[^}]*border-radius:22px 22px 0 0/)
  assert.match(patched, /\[data-composer-seat\]:has\(\.dshCyberPlan_root\)[^{]*\{gap:0;--dsh-composer-stack-gap:0px\}/)
  assert.match(patched, /\[data-composer-seat\]:has\(\.dshCyberPlan_root\) \[data-composer-card\]\{border-radius:0 0 22px 22px\}/)
  assert.match(patched, /function ChromeOperationIndicator\(\)/)
  assert.match(patched, /fetch\("\/api\/webbridge\/status"/)
  assert.match(patched, /fetch\("\/api\/webbridge\/activate"/)
  assert.match(patched, /"data-chrome-operation": ""/)
  assert.match(patched, /"Chrome操作中"/)
  assert.match(patched, /id: "chrome-operation"/)
  assert.doesNotMatch(patched, /虾缸/)
})
