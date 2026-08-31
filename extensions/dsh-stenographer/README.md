# 大神速记员

速记员是大神会话头部的独立工具。它面向会议、访谈和现场讨论：录音、中文转写、说话人区分和记录内容都留在本机，结束后可以把整理任务交给一个新的本地模型会话。

## 使用方法

1. 在会话头部点击“速记员”。面板顶部始终显示当前状态、记录段数和保存状态。
2. 选择录音来源：麦克风、系统声音，或“麦克风 + 系统声音”。线上会议通常选择最后一项；预计人数可以保持“自动识别”。
3. 点击“开始速记”。大神 App 会先检查本地模型，再请求系统权限。没有原生录音桥时，面板会明确提示不可用，不会伪造录音。
4. 录音中可以暂停、继续或结束。关闭面板、切换会话或隐藏窗口不会停止录音；头部按钮会持续显示红色录音状态。
5. 实时记录按块显示：每段有说话人、时间戳和“临时/最终”标记。点击段落可以编辑文字，也可以改说话人名称；“文字”和“图片”按钮会把备注或图片插入当前选中块之后。
6. 点击“结束速记”后，原生采集先停止，服务端再执行最终转写和说话人校正。校正过程中面板显示“最终校正”和进度。
7. 状态为“已就绪”后选择“整理会议纪要”“编写汇报邮件”“编写需求文档”或“自定义用途”。点击生成后，速记服务把完整速记文本交给 `zhipu-glm / glm-5.3-flash`，把完整成品持久化并返回面板。结果支持“一键复制全部”；需要继续修改时，再点击“在新会话中继续修改”。

## 状态说明

| 状态 | 含义 | 用户可以做什么 |
| --- | --- | --- |
| 尚未开始 | 当前没有打开的速记记录 | 选择来源并开始 |
| 模型准备 | 正在检查本地转写和声纹模型 | 等待，不要重复点击 |
| 请求权限 | macOS 正在请求麦克风或系统声音权限 | 按系统提示允许或拒绝 |
| 正在录音 | 正在采集和转写 | 暂停、继续、结束，或关闭面板 |
| 已暂停 | 采集暂时停止，记录已保存 | 继续或结束 |
| 停止处理中 | 正在等待音频写入完成 | 等待最终校正 |
| 最终校正 | 正在用完整音频校正文字和说话人 | 等待结果 |
| 已就绪 | 记录可以编辑和交接 | 修改、插图或选择用途 |
| 需要恢复 | 上次采集发生中断 | 安全恢复，或结束并校正 |
| 失败 | 服务、权限或模型发生错误 | 查看错误，重新读取或恢复历史记录 |

## 编辑和保存规则

- 转写块、文字块和图片块都有稳定 ID；轮询只更新服务端新增内容，不按字符位置重排用户插入的块。
- 修改转写文字会标记 `userEdited=true`；最终校正不能覆盖这段文字。
- 改名通过 `speakerNames` 保存。声纹重新聚类后仍按稳定说话人 lineage 恢复名称。
- 图片先以受限 base64 上传到 `/api/stenographer/sessions/:id/media`，再写入一个 image block。支持 PNG、JPEG、WebP、GIF；单张图片不超过 10 MiB。
- 编辑使用 session `revision` 做 PATCH；遇到 `REVISION_CONFLICT` 时保留本地编辑并提示用户，不静默覆盖。
- 每秒读取当前 session；历史列表每 5 秒刷新。历史记录可以重新打开 `interrupted` 或 `ready` 会话。
- 历史记录右侧提供删除按钮。正在录音或最终校正的记录不能删除；其他记录确认后移入 `/Users/marcus/.dsh/private/stenographer/.trash`，不会立即永久擦除。

## 隐私、权限和模型

- 速记音频、记录文档、声纹向量和图片由 Host 保存到 `/Users/marcus/.dsh/private/stenographer`；音频不会上传到第三方。只有用户点击生成成品时，最终速记文本才会发送给 GLM-5.3-Flash。
- 使用麦克风前，需要在“系统设置 → 隐私与安全性 → 麦克风”允许大神；录制系统声音还需要允许屏幕与系统音频采集。修改权限后重启大神 App 再试。
- 录音格式由原生 bridge 提供：16 kHz、单声道、PCM16；麦克风和系统声音按来源保持独立序号。浏览器环境没有 `window.webkit.messageHandlers.stenographer` 时不能开始。
- 中文转写优先使用本机 FunASR Paraformer-large，并进行字间空格、重复短句、静音幻觉和越界片段清理；Paraformer 进程异常时才回退到 MLX Whisper large-v3-turbo。说话人区分使用 FunASR ERes2NetV2。成品加工固定选择 `zhipu-glm / glm-5.3-flash`，不会静默切换到其他写作模型。
- `paid_api_fallback` 固定为 `false`，表示 GLM-5.3-Flash 失败时不自动改用别的供应商或本地模型；界面会显示明确错误并允许重试。

## 中断恢复

速记员启动时会读取本地历史。发现 `interrupted`、`recording`、`paused` 或 `finalizing` 记录时，只显示“需要恢复”，不会自动打开麦克风或自动继续录音。

打开记录后：

- 原生 bridge 仍可用：点击“安全恢复”，使用同一个 session ID 继续采集。
- 不想继续采集：点击“结束并校正”，让服务端先冲刷已经保存的音频，再生成最终记录。
- 如果恢复失败，保留原 session 和错误信息；可以稍后从历史列表再次打开，不会删除原始录音。

关闭面板只影响显示，不调用 `stop`。只有点击“结束速记”才会向 `window.webkit.messageHandlers.stenographer` 发送 `{ action: "stop", sessionId }`。

## API 和扩展边界

客户端只调用 `/api/stenographer` v1 合同中的接口：`health`、`sessions`、`sessions/:id`、`document`、`media`、`audio`、`state`、`finalize` 和 `handoff`。它通过 `@local/dsh-stenographer` 注册 `conversation.session.header.utilities`，不修改“项目与产物”面板及其全局变量。

新会话交接严格使用大神官方会话 API：`ctx.sessions.create`、`ctx.sessions.open`、`ctx.modelDirectories.directoryFor(id).select`、`conversation.input.for(scope).setDraft` 和 `submit`。不使用 `document.querySelector`、按钮 click、textarea setter 或其他 DOM 发送方式。

## 验证

```sh
node --test extensions/dsh-stenographer/client.test.mjs
git diff --check -- extensions/dsh-stenographer/client.js extensions/dsh-stenographer/client.test.mjs extensions/dsh-stenographer/README.md
```

客户端测试覆盖模块注册、状态文案、统一响应解析、三种录音来源、块和图片顺序、`userEdited` 保护、历史状态、revision payload、原生 bridge、本地模型选择、官方提交链路以及无 DOM 发送 hack。真实麦克风、ScreenCaptureKit、长时录音和 `/Applications/大神.app` 验收仍需由集成和发布节点完成。
