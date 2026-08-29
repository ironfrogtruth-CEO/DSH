# CyberMarcus UI 布局修复审计

## 结论

- 知识库弹窗的列表与详情已修正为 `.dsh-kb-content` 的两个同级子节点；此前详情节点嵌在列表节点内，所以截图中右栏为空、内容全部落到左栏。
- 侧边栏底部插槽锚点原本由宿主以 `display: contents` 渲染，工具入口继承横向 flex。现在余额独占第一行，设置与钉钉共享第二行；布局由稳定的 `data-dsh-sidebar-foot`/`data-slot` 合同控制，统一 36px 高度、全宽和间距；折叠态固定 36px 单列图标。
- 虾缸知识库已从 sidebar footer 移除并注册到正式 `settings.section`（order 100），在设置左侧导航显示，右侧直接复用列表/详情双栏 CRUD 页面，不再套第二层弹窗。
- 旧的 `max-width:760px` 规则会把 HiDPI Mac 的 CSS 视口误判为移动端。知识库和钉钉面板的后置布局合同只在触摸窄屏或极窄视口上下堆叠；普通 Mac App 保持列表左、详情右。
- 收起侧边栏时，按钮内的 `railMark` 和上游面板 SVG 都隐藏，只保留虾缸图标作为明确的“打开侧边栏”入口。
- 展开态品牌只对 `.shrimp-harness-brand::before` 增加 `translateY(6px)`，校正裁切 wordmark 的透明下留白；`DELIVERY` 的尺寸、位置、资源和折叠态 `.shrimp-rail-brand` 均保持不变，深浅色资源继续分别使用原有 wordmark。
- 钉钉面板不贴窗口最右侧：通过 `ResizeObserver` 读取实际侧边栏宽度，使用 `--dsh-sidebar-half-width` 将面板中心对齐右侧会话区；收起态使用实时 36px rail，窄屏继续 8px inset。

## 验证

- `node --check extensions/dsh-dingtalk-status/client.js`
- `node --test extensions/dsh-dingtalk-status/index.test.mjs extensions/dsh-dingtalk-status/client.test.mjs`（5/5）
- `node --test scripts/ensure-web.test.mjs`（4/4）
- `node --test extensions/shrimp-shell/header-controls.test.mjs`（含品牌垂直微调合同）
- `profiles/web/node_modules/@local/dsh-dingtalk-status` 与 `dsh-knowledge-manager` 均为源码目录的实时 symlink，无第二份客户端 bundle 漂移。

## 限制与验收边界

- 本次未重启 Host、未操作真实浏览器窗口、未提交 Git；待主代理统一重载后做原生 DOM/截图验收。
- 触摸窄屏仍按上下堆叠；细指针 Mac 窗口即使 CSS 像素较小也保留两列，内容不足时允许内容区水平滚动。
