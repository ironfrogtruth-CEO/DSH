// dsh-dsbalance — Host half(静态 bundle 插件)
// 提供 /api/dsbalance/balance 路由: 读对应品牌 API Key → 调余额接口 → JSON
// 支持 ?provider=deepseek(默认) | zhipu
// DeepSeek: DEEPSEEK_API_KEY → api.deepseek.com/user/balance
// 智谱: 无公开 REST 余额查询 API, 如实降级返回 balanceUnknown + 充值入口
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
      const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider') || 'deepseek'
      try {
        if (provider === 'zhipu') {
          // 智谱开放平台无公开的 API-Key 余额接口;
          // 真实余额取自控制台会话态 JWT(BIGMODEL_WEB_TOKEN, 由 sync-zhipu-cookie.sh 从 Chrome 同步):
          //   GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report
          //   Authorization: <bigmodel_token_production 的 JWT>
          const web = await ctx.credentials.resolve('BIGMODEL_WEB_TOKEN')
          const token = web && web.value
          if (!token) {
            send(200, { ok: true, provider: 'zhipu', balanceUnknown: true, topUpUrl: 'https://open.bigmodel.cn/finance/topup', error: '未配置 BIGMODEL_WEB_TOKEN（浏览器登录态未同步）' })
            return
          }
          const spz = ctx.get('sandboxPolicy')
          const cwdz = spz && spz.workspaceRoot ? spz.workspaceRoot : '/'
          const procz = ctx.subprocess.spawn({
            argv: [
              '/usr/bin/curl', '-sS', '--max-time', '10',
              'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
              '-H', 'Authorization: ' + token,
            ],
            cwd: cwdz,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 65536 },
              stderr: { maxBytes: 4096 },
            },
            graceMs: 5000,
          })
          const outcomez = await procz.done
          const collectedz = procz.collected
          const textz = collectedz && collectedz.stdout ? collectedz.stdout.readFrom(0).text : ''
          if (outcomez.exitCode !== 0) {
            send(200, { ok: true, provider: 'zhipu', balanceUnknown: true, topUpUrl: 'https://open.bigmodel.cn/finance/topup', error: '余额接口请求失败(exit=' + String(outcomez.exitCode) + ')' })
            return
          }
          let dataz
          try {
            dataz = JSON.parse(textz)
          } catch (e) {
            send(200, { ok: true, provider: 'zhipu', balanceUnknown: true, topUpUrl: 'https://open.bigmodel.cn/finance/topup', error: '余额接口响应解析失败' })
            return
          }
          const dz = dataz && dataz.data
          if (!dataz || dataz.code !== 200 || !dz || typeof dz.availableBalance !== 'number') {
            send(200, { ok: true, provider: 'zhipu', balanceUnknown: true, topUpUrl: 'https://open.bigmodel.cn/finance/topup', error: '登录态已过期或不可用，请重新同步' })
            return
          }
          const f2 = (x) => Number(x).toFixed(2)
          send(200, {
            ok: true,
            provider: 'zhipu',
            isAvailable: true,
            infos: [{
              currency: 'CNY',
              total: f2(dz.availableBalance),
              granted: f2(dz.giveAmount ?? 0),
              toppedUp: f2(dz.rechargeAmount ?? 0),
              spend: f2(dz.totalSpendAmount ?? 0),
            }],
            fetchedAt: Date.now(),
          })
          return
        }
        const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
        if (!cred || !cred.value) {
          send(200, { ok: false, provider: 'deepseek', error: '未配置 DEEPSEEK_API_KEY' })
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
          send(200, { ok: false, provider: 'deepseek', error: '余额接口请求失败(exit=' + String(outcome.exitCode) + ')' })
          return
        }
        let data
        try {
          data = JSON.parse(text)
        } catch (e) {
          send(200, { ok: false, provider: 'deepseek', error: '余额接口响应解析失败' })
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
        send(200, { ok: true, provider: 'deepseek', isAvailable: !!data.is_available, infos, fetchedAt: Date.now() })
      } catch (e) {
        send(500, { ok: false, provider, error: String(e && e.message ? e.message : e) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsbalance: /api/dsbalance/balance')
}
