# DSH 自定义 UI 补丁备份

本目录保存对 DeepSeek Harness 的自定义 UI 修改。
当前 `client.js.original` / `client.js.modified` 已在 2026-08-20 迁移到 `0.1.0-rc.8`；
升级前的 rc.7 完整安装和补丁已收入 `backups/pre-rc8-20260820-120111/`。

## 修改内容

1. **隐藏右上角"Session log"按钮**(dsh-session-log-export)
2. **会话 header 改造**(dsh-client-ui-conversation):
   - tabs 行 = [对话][抓虾][我的虾] 三个用户任务入口
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

- 当前补丁基于 `@deepseek-ai/dsh 0.1.0-rc.8`；再次升级时必须先对新版原始 bundle 做兼容比对，不得直接覆盖。
- 所有修改在 bundle 中都有 `[local-mod]` 注释标记，便于查找。
- rc.8 起使用官方原生图片附件能力；DeepSeek 文本模型仍由 `shrimp-shell` 识图桥接，生图仍由 `zhipu-media` 提供。
