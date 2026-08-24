import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

function loadScheduleFormatter() {
  const start = clientSource.indexOf('      const HEARTBEAT_DAY_LABELS =')
  const end = clientSource.indexOf('      const dot =', start)
  assert.ok(start >= 0 && end > start, 'heartbeat schedule formatter must stay in client.js')
  const context = {}
  vm.runInNewContext(`${clientSource.slice(start, end)}\nglobalThis.__formatHeartbeatSchedule = formatHeartbeatSchedule`, context)
  return context.__formatHeartbeatSchedule
}

test('详情页优先显示 cron 周期，不把周一三五日误显示成 10080 分钟', () => {
  const formatHeartbeatSchedule = loadScheduleFormatter()
  assert.equal(formatHeartbeatSchedule({
    interval: 604800,
    cron: { time: '06:00', days: [1, 3, 5, 0], timezone: 'Asia/Shanghai' },
  }), '周一、周三、周五、周日 06:00')
})

test('cron 天数支持字符串和 7=周日，并去重排序', () => {
  const formatHeartbeatSchedule = loadScheduleFormatter()
  assert.equal(formatHeartbeatSchedule({ interval: 604800, cron: { time: '08:05', days: ['5', '1', 7, '1'] } }), '周一、周五、周日 08:05')
})

test('没有完整 cron 时才回退显示 interval 分钟', () => {
  const formatHeartbeatSchedule = loadScheduleFormatter()
  assert.equal(formatHeartbeatSchedule({ interval: 604800 }), '每 10080 分钟')
  assert.equal(formatHeartbeatSchedule({ interval: 3600, cron: { time: '06:00', days: [] } }), '每 60 分钟')
})

test('详情页已绑定 formatter，未改动心跳开关与调度字段', () => {
  assert.match(clientSource, /已开启 · \$\{formatHeartbeatSchedule\(selectedHeartbeat\)\}/)
  assert.doesNotMatch(clientSource, /已开启 · 每 \$\{Math\.max\(1, Math\.round\(\(selectedHeartbeat\.interval \|\| 0\) \/ 60\)\)\} 分钟/)
})
