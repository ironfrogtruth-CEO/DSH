# DSH 自定义 UI 补丁备份

本目录保存对 DeepSeek Harness 的自定义 UI 修改。
会话、任务、Skill、轨迹与 Session log 的 `client.js.original` /
`client.js.modified` 已在 2026-08-24 迁移到 `0.1.1-rc.2`；升级前的
rc.8 完整运行时与补丁已收入离线回滚快照。子代理包在新版把入口从
`header.actions` 改为 `header.lineage`，因此保留官方新版交互，不强行覆盖新版
会话入口。

## 修改内容

1. **隐藏右上角"Session log"按钮**(dsh-session-log-export)
2. **会话 header 改造**(dsh-client-ui-conversation):
   - tabs 行 = [对话][抓虾][我的虾] 三个用户任务入口
   - 2026-08-25: 把 deepseek-idesign / deepseek-ippt 的视图 id(`ipollowork-design-studio`、`ipollowork-ppt-studio`)加入 `PRIMARY_VIEW_IDS`,Design / PPT 作为主入口 tab 出现,交互与现有 tab 完全一致;`ACTIVE_VIEW_IDS` 由 PRIMARY 展开自动包含,可正常恢复视图
   - 后台任务、子代理和 Skill 继续注册给运行时使用，但不再占据主导航
   - 历史会话若持久化在已隐藏视图，打开时自动回到“对话”，不会落入无返回入口的页面
   - utilities 区固定顺序为：轨迹 → 心跳 → Git → 项目与产物
   - 心跳打开周期任务浮层；Git 打开工作区版本面板，不占主任务 tab
   - 2026-08-25: 父会话信息流增加 durable 子代理状态 rail；每个 pill 从 `useSessions` 的
     `origin/parentId/running/completed/pendingInteraction` 与 `projectionValues.subagent`
     读取真实子代理身份和生命周期，点击通过正式 `sessions.openSubagent` 地址进入对应子会话；
     并行子代理各自独立更新，状态结束后保留在信息流
3. **按需出现的会话 header 后台任务入口**(dsh-client-ui-jobs):只在当前会话已有后台任务时出现，横向显示运行数、已运行/耗时和终态；不占主导航，也不把任务数据移出会话状态
4. **子代理 tab**(dsh-client-ui-subagent):全视图子代理树,三色状态灯(绿=运行中/黄=等待中/灰=已完成),点击行不跳转
5. **Skill tab**(dsh-client-ui-skill):全视图 skill 列表(名称+描述)
6. **shrimp-shell 扩展**(~/.dsh/extensions/shrimp-shell/,升级不受影响):
   - 保留原虾缸 wordmark、首页虾形标志、DELIVERY 标识和 `Visible Workflow. Reliable Intelligence.` slogan
   - 原生提供“抓虾”“我的虾”、会话匹配、运行状态、心跳与虾详情
   - "项目与产物"面板默认展开选中工作区 output/ 目录(自动创建)
   - 产物从新到旧排序(host 端已按 mtime 降序)
   - 点击面板外区域关闭
   - 系统提示注入产物输出约定(output/ 目录)
7. **Git 工作台**(~/.dsh/extensions/dsh-git/):
   - 仓库选择、分支和改动状态、单文件 diff、暂存/取消暂存、提交、推送
   - 支持“提交并推送”：暂存全部 → 本地 commit → 推送 GitHub
   - 写操作均有确认门；路径只允许 Desktop 与 ~/.dsh 下的真实 Git 仓库
8. **Design/PPT Studio 品牌**(custom-ui-patches/dsh-idesign-ippt-studio/):
   - 2026-08-25: iDesign→HTML、iPPT→皮皮虾、by iPolloWork→by ShrimpTank
   - 全部模板 iPolloWork→ShrimpTank + 品牌图标替换为虾缸 mark(无文字)
   - PPTX 导出 span 覆盖检查修复(tVe 文本标签补 span 等内联标签)
   - bundle 重命名 -ipw.js 规避 immutable 缓存;index.html 注入品牌强制脚本,导出后不回退
   - 升级后重放:bash custom-ui-patches/dsh-idesign-ippt-studio/replay-brand.sh
9. **大神 App macOS 菜单栏图标**(apps/大神.swift):
   - 2026-08-25: 新增 NSStatusItem(顶部菜单栏小 logo),图标取自虾缸 mark-dark 反转的浅色版(无文字),深色菜单栏上醒目
   - 图标: apps/menubar-logo.png → 大神.app/Contents/Resources/
   - 编译: swiftc -O -target arm64-apple-macosx12.0 -o 大神-arm64 大神.swift -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
10. **Agent preset 选择器与管理页**(dsh-client-ui-agent-preset):
   - 新会话 chip、设置项和管理卡片显示完整 Host roster，不隐藏 `standard`/`code`/`minimal`/`cordis` 等 DeepSeek Harness 原生模式
   - 保留 CyberMarcus，新增 Avengers；已删除的 `reliable-local` 不再作为可选 preset，历史会话 header 仅保留名称兼容
   - `scripts/ensure-web` 已把该 bundle 纳入 load signature；升级后可用 `client.js.modified` 重放
11. **侧栏未分组入口投影**(dsh-client-ui-workspace):
   - grouped sidebar 不渲染 `Ungrouped` 行；Host/API 返回的松散会话、flat 模式和搜索数据不改动
   - 顶部子代理入口及 `dsh-client-ui-subagent` bundle 不改动
   - 升级后将 `client.js.modified` 重放到 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`；验证 `client.test.mjs`
12. **顶部 utilities 稳定合同**(shrimp-shell + dsh-git):
   - 轨迹、心跳、Git、项目与产物固定为 36px 单行胶囊，SVG 固定 16px，禁止 stretch、折行或变成大卡片
   - utilities 容器在窄宽度下保持横向布局并允许收纳；MutationObserver 在刷新/HMR 后重新核对合同
   - 真实验收覆盖 1440、1024、800 三种宽度，验证 `extensions/shrimp-shell/header-controls.test.mjs`

## 文件说明

每个包目录下:
- `client.js.modified` — 修改后的 bundle(重新应用用这个)
- `client.js.original` — 修改前的原版(回滚用这个)

shrimp-shell 还有 `index.js.modified` / `index.js.original`(host 端)。

## 如何重新应用(升级 DSH 后)

先检查当前锁定版本是否完整应用：

```bash
node /Users/marcus/.dsh/scripts/replay-custom-ui-patches.mjs --check
```

同为 `0.1.1-rc.2` 且只是重新安装覆盖了 bundle 时，可原子重放：

```bash
node /Users/marcus/.dsh/scripts/replay-custom-ui-patches.mjs --apply
```

脚本检测到新的 DSH 版本会拒绝覆盖。必须先把候选版本安装到隔离目录，完成 bundle 兼容比对、功能回归和真实 UI Gate；不得使用旧 bundle 盲目覆盖新版。

```bash
# 升级后 bundle 被覆盖时:
cp /Users/marcus/.dsh/custom-ui-patches/dsh-client-ui-conversation/client.js.modified \
   /Users/marcus/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
# ... 对每个包重复(client.js 修改后浏览器刷新即可生效,无需重启)

# shrimp-shell 扩展不受 npm 升级影响,一般无需重放
```

## 如何回滚

```bash
# 用 .original 覆盖回去,然后重启 dsh web(host 端)或刷新浏览器(client 端)
cp /Users/marcus/.dsh/custom-ui-patches/<包名>/client.js.original \
   /Users/marcus/.dsh/install/node_modules/@deepseek-ai/<包名>/lib/client.js
```

## 注意

- 当前已应用补丁基于 `@deepseek-ai/dsh 0.1.1-rc.2`；再次升级时必须先对新版原始 bundle 做兼容比对，不得直接覆盖。
- 所有修改在 bundle 中都有 `[local-mod]` 注释标记，便于查找。
- rc.2 使用官方 durable 图片附件能力；所有会话模型的用户图片都由 `shrimp-shell` 固定先走智谱免费 GLM 识图桥，智谱不可用时才回退本地 Gemma。原图仍保留在用户消息，桥接只替换模型请求的临时视图；生图继续由 `zhipu-media` 提供。
