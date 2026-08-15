// dsbalance — Host half(作为 cordis_define 的 code.host 传入)
// 依赖: credentials 服务(DEEPSEEK_API_KEY)、subprocess 服务(调 curl)、harness builtin
return {
  apply(ctx) {
    const credentials = ctx.get('credentials')
    const subprocess = ctx.get('subprocess')
    if (credentials === undefined || subprocess === undefined) return

    const dispose = harness.handle('dsbalance.get', async () => {
      try {
        const cred = await credentials.resolve('DEEPSEEK_API_KEY')
        if (!cred || !cred.value) {
          return { ok: false, error: '未配置 DEEPSEEK_API_KEY(见 ~/.dsh/.credentials.yaml)' }
        }
        const sp = ctx.get('sandboxPolicy')
        const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : '/'
        const proc = subprocess.spawn({
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
          return { ok: false, error: '余额接口请求失败(exit=' + String(outcome.exitCode) + ')' }
        }
        let data
        try {
          data = JSON.parse(text)
        } catch (e) {
          return { ok: false, error: '余额接口响应解析失败' }
        }
        const infos = Array.isArray(data.balance_infos)
          ? data.balance_infos.map((b) => ({
              currency: b.currency,
              total: b.total_balance,
              granted: b.granted_balance,
              toppedUp: b.topped_up_balance,
            }))
          : []
        return { ok: true, isAvailable: !!data.is_available, infos, fetchedAt: Date.now() }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    })
    ctx.effect(() => dispose)
  },
}
