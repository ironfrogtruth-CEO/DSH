# DSH 自定义 UI 补丁备份

本目录保存对 DeepSeek Harness 的自定义 UI 修改。
会话、任务、Skill、轨迹与 Session log 的 `client.js.original` /
`client.js.modified` 已在 2026-08-24 迁移到 `0.1.1-rc.2`；升级前的
rc.8 完整运行时与补丁已收入离线回滚快照。子代理包在新版把入口从
`header.actions` 改为 `header.lineage`，因此保留官方新版交互，不强行覆盖旧
`conversation.view` 补丁。

## 修改内容

1. **隐藏右上角"Session log"按钮**(dsh-session-log-export)
2. **会话 header 改造**(dsh-client-ui-conversation):
   - tabs 行 = [对话][抓虾][我的虾] 三个用户任务入口
   - 2026-08-25: 把 deepseek-idesign / deepseek-ippt 的视图 id(`ipollowork-design-studio`、`ipollowork-ppt-studio`)加入 `PRIMARY_VIEW_IDS`,Design / PPT 作为主入口 tab 出现,交互与现有 tab 完全一致;`ACTIVE_VIEW_IDS` 由 PRIMARY 展开自动包含,可正常恢复视图
   - 后台任务、子代理和 Skill 继续注册给运行时使用，但不再占据主导航
   - 历史会话若持久化在已隐藏视图，打开时自动回到“对话”，不会落入无返回入口的页面
   - utilities 区固定顺序为：轨迹 → 心跳 → Git → 项目与产物
   - 心跳打开周期任务浮层；Git 打开工作区版本面板，不占主任务 tab
3. **后台任务 tab**(dsh-client-ui-jobs):全视图任务列表,无标题、紧凑排版
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

## 文件说明

每个包目录下:
- `client.js.modified` — 修改后的 bundle(重新应用用这个)
- `client.js.original` — 修改前的原版(回滚用这个)

shrimp-shell 还有 `index.js.modified` / `index.js.original`(host 端)。

## 如何重新应用(升级 DSH 后)

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
- rc.8 起使用官方原生图片附件能力；DeepSeek 文本模型仍由 `shrimp-shell` 识图桥接，生图仍由 `zhipu-media` 提供。
