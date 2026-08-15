# 跨平台兼容

## 通用包结构

```text
enterprise-health-report/
├── SKILL.md
├── agents/openai.yaml
├── assets/
│   ├── a4-health-theme.css
│   └── a4-health-editor.js
├── templates/
│   └── a4-health-report-template.html
├── references/
└── scripts/
```

所有模板使用相对路径，不依赖个人主目录绝对路径。迁移时复制整个目录。

## 本地企业健康报告生产线

本项目运行时从以下目录加载 skill 包：

```text
resources/skills/enterprise-health-report
```

启动服务、读取模板、调用 DeepSeek、生成 HTML/PDF 和 QA 均由项目内代码完成，不依赖外部 AI 开发工具的 skill 注册目录。

## 扣子 / Coze

建议映射：

- 主提示词：`SKILL.md`
- 知识文件：`references/*.md`
- 附件资源：`assets/*`, `templates/*`
- 工具脚本：`scripts/validate_health_report.py`

如果平台不能执行脚本，把 `scripts/validate_health_report.py` 的检查项作为发布前人工 QA 清单。

## 马维斯 / Mavis

建议把整个目录作为工作流资源包，主入口指向 `SKILL.md`。HTML 输出节点复制 `templates/a4-health-report-template.html`，并保持 assets 相对路径。

## WorkBuddy

建议作为“技能/模板包”导入。将 `SKILL.md` 设置为工作指令，`assets/` 和 `templates/` 设置为可复制资源，`scripts/` 设置为校验动作。

## qclaw

建议将目录作为本地 skill bundle。若 qclaw 只接受英文目录，保留 `enterprise-health-report`；在 UI 里展示“企业健康报告”。

## 不兼容时的降级

- 不能运行 JS：仍可生成静态 HTML，但不承诺在线编辑能力。
- 不能运行 Python：用 `references/qa-gates.md` 手动 QA。
- 不能保留文件夹相对路径：把 CSS/JS 内联进 HTML，但仍保留原始 skill 包作为源。
