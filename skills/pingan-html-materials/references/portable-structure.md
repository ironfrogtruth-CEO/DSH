# Skill 可移植结构

## 1. 推荐迁移单元

迁移到 Coze、WorkBuddy 或其他工作台时，优先整体复制：

```text
html_materials/skill/
```

该文件夹现在包含运行时、模板、视觉规范、精简知识库和精选素材库，不再依赖本机绝对路径才能工作。

但要区分两种部署级别：

| 部署级别 | 需要内容 | 能力 |
| --- | --- | --- |
| 轻量单包 | `html_materials/skill/` | 可生成和编辑 HTML，可使用精简售前知识与精选素材。 |
| 完整生产包 | `html_materials/skill/` + `知识库/` + `素材库/` | 可生成和编辑 HTML，并具备完整知识真相、真源追溯和全量素材替换能力。 |

## 2. 目录职责

```text
html_materials/skill/
├── SKILL.md                         # 生产规则入口
├── skill.config.json                # 机器读取配置
├── assets/
│   ├── report-theme.css             # 16:9 平安风视觉与打印 CSS
│   └── editor-core.js               # 编辑、替换、保存、PDF 前清理
├── templates/
│   └── editable-report-template.html # 默认 HTML 模板
├── references/                      # 设计、素材、生产流程说明
├── resources/
│   ├── resource-manifest.json        # 便携资源清单
│   ├── visual-component-library/             # 可调用素材库
│   └── knowledge/presale/            # 精简售前知识库
└── qa/
    └── qa-checklist.md
```

## 3. 路径策略

- 生成 HTML 时不要写死 `/Users/...` 绝对路径。
- 默认使用相对路径：`resources/visual-component-library`。
- 如果 HTML 输出在 skill 文件夹外，必须设置：

```html
<body data-asset-root="相对/或/绝对/素材库路径">
```

- 每个素材元素必须保留：

```html
data-asset-id="gen.icon_vaccine_syringe"
data-replacement-group="service.vaccine"
```

## 4. 本机兼容

本机仍可读取完整知识库和素材库：

```text
../../../知识库
../../../素材库
```

完整知识库存在时，它不是普通 fallback，而是**优先事实真相层**；`resources/knowledge/presale` 仅是完整知识库缺失时的便携回退。
