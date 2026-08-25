// dsh-shrimp-run-status — Host read-only runtime bridge.
//
// Ordinary ShrimpTank runs still use /api/shrimp/tank. This narrow endpoint
// covers a heartbeat runner launched through bash: before a run id exists it
// projects the fixed batch checkpoint; afterwards the client switches to the
// canonical ShrimpTank run.
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-shrimp-run-status'
export const inject = ['webServer']

export const HEARTBEAT_CHECKPOINT = '/Users/marcus/Desktop/虾缸/output/article/.heartbeat_batch.json'
export const HEARTBEAT_STATE = join(homedir(), '.dsh', 'heartbeats.json')
const MAX_JSON_BYTES = 2 * 1024 * 1024
const TERMINAL = new Set(['done', 'completed', 'succeeded', 'success', 'failed', 'error', 'blocked', 'stopped', 'cancelled', 'canceled'])
const text = (value) => String(value ?? '')

async function readJsonFile(path, readFileImpl = readFile) {
  const raw = await readFileImpl(path, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) throw new Error('运行状态文件过大')
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行状态不是对象')
  return value
}

function runnerAlive(execFileImpl = execFile) {
  return new Promise((resolvePromise) => {
    execFileImpl('/usr/bin/pgrep', ['-f', '[/]scripts/heartbeat_gzh_publish.py|[h]eartbeat_gzh_publish.py'], { timeout: 2000 }, (error, stdout) => {
      resolvePromise(!error && /^\s*\d+/m.test(text(stdout)))
    })
  })
}

function terminalStatus(value) {
  const normalized = text(value).trim().toLowerCase()
  return TERMINAL.has(normalized) ? normalized : ''
}

export async function heartbeatRuntimeStatus({ readFileImpl = readFile, execFileImpl = execFile } = {}) {
  let checkpoint
  try { checkpoint = await readJsonFile(HEARTBEAT_CHECKPOINT, readFileImpl) } catch {
    return { ok: true, exists: false, source: 'heartbeat-checkpoint.v1' }
  }
  let heartbeatState = { tasks: [] }
  try { heartbeatState = await readJsonFile(HEARTBEAT_STATE, readFileImpl) } catch { /* checkpoint remains authoritative */ }
  const taskId = text(checkpoint.heartbeat_task_id)
  const tasks = Array.isArray(heartbeatState.tasks) ? heartbeatState.tasks : []
  const task = tasks.find((item) => text(item?.id) === taskId) || tasks.find((item) => text(item?.runner) === 'gzh-multi-article') || {}
  const runs = (Array.isArray(checkpoint.runs) ? checkpoint.runs : []).map((item) => ({
    out: text(item?.out).slice(0, 120),
    kind: text(item?.kind).slice(0, 80),
    runId: text(item?.run_id || item?.runId).slice(0, 300),
    status: text(item?.status).slice(0, 80),
  }))
  const current = [...runs].reverse().find((item) => item.runId) || runs.at(-1) || null
  const running = await runnerAlive(execFileImpl)
  const login = text(checkpoint.login_preflight || 'pending')
  const publish = text(checkpoint.publish_status || 'pending')
  const verify = text(checkpoint.multi_verify_status || 'pending')
  const completed = Boolean(checkpoint.merge_completed) && /^(done|passed|success|succeeded|completed)$/i.test(publish) && /^(done|passed|success|succeeded|completed)$/i.test(verify)
  const currentTerminal = terminalStatus(current?.status)
  const status = running ? 'running' : completed ? 'completed' : currentTerminal || 'interrupted'
  const stage = login !== 'passed' ? 'login_preflight'
    : current?.runId && !currentTerminal ? `run:${current.out || current.kind || 'article'}`
      : !checkpoint.merge_completed ? 'merge'
        : !/^(done|passed|success|succeeded|completed)$/i.test(publish) ? 'publish'
          : 'verify'
  return {
    ok: true,
    exists: true,
    source: 'heartbeat-checkpoint.v1',
    batchId: text(checkpoint.batch_id).slice(0, 200),
    taskId: taskId || text(task.id).slice(0, 200),
    taskName: text(task.name || '虾六答').slice(0, 160),
    pipelineSlug: text(task.pipelineSlug || 'shrimp-c433b57dac59419d').slice(0, 200),
    status,
    terminal: !running && (completed || Boolean(currentTerminal)),
    processRunning: running,
    stage,
    loginPreflight: login,
    publishStatus: publish,
    verifyStatus: verify,
    createdAt: text(checkpoint.created_at).slice(0, 100),
    updatedAt: text(checkpoint.updated_at).slice(0, 100),
    expectedRuns: Array.isArray(checkpoint.topics) ? checkpoint.topics.length : 3,
    runs,
    currentRunId: current?.runId || '',
    currentOut: current?.out || '',
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-shrimp-run-status/heartbeat',
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '只允许 GET' }); return }
      try { sendJson(res, 200, await heartbeatRuntimeStatus()) }
      catch (error) { sendJson(res, 500, { ok: false, error: text(error?.message || error).slice(0, 500) }) }
    },
  }), 'dsh-shrimp-run-status: heartbeat runtime status')
}
