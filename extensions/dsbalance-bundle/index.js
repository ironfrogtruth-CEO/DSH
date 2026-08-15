// dsh-dsbalance — Host half(静态 bundle 插件)
// 提供 /api/dsbalance/balance 路由: 读 DEEPSEEK_API_KEY → 调 DeepSeek 余额接口 → JSON
export const name = 'dsh-dsbalance'

export const inject = ['credentials', 'subprocess', 'webServer']

export function apply(ctx) {
  const route = {
    kind: 'exact',
    path: '/api/dsbalance/balance',
    handler: async (req, res) => {
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
        if (!cred || !cred.value) {
          send(200, { ok: false, error: '未配置 DEEPSEEK_API_KEY' })
          return
        }
        const sp = ctx.get('sandboxPolicy')
        const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : '/'
        const proc = ctx.subprocess.spawn({
          argv: [
            '/usr/bin/curl', '-sS', '--max-time', '10',
            'https://api.deepseek.com/user/balance',
            '-H', 'Authorization: Bearer ' + cred.value,
          ],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 5000,
        })
        const outcome = await proc.done
        const collected = proc.collected
        const out = collected && collected.stdout
        const text = out ? out.readFrom(0).text : ''
        if (outcome.exitCode !== 0) {
          send(200, { ok: false, error: '余额接口请求失败(exit=' + String(outcome.exitCode) + ')' })
          return
        }
        let data
        try {
          data = JSON.parse(text)
        } catch (e) {
          send(200, { ok: false, error: '余额接口响应解析失败' })
          return
        }
        const infos = Array.isArray(data.balance_infos)
          ? data.balance_infos.map((b) => ({
              currency: b.currency,
              total: b.total_balance,
              granted: b.granted_balance,
              toppedUp: b.topped_up_balance,
            }))
          : []
        send(200, { ok: true, isAvailable: !!data.is_available, infos, fetchedAt: Date.now() })
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsbalance: /api/dsbalance/balance')
}
