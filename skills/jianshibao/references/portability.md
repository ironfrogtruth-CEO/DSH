# 可移植安装说明

## 包结构

建议交付两个包：

1. `检视宝` skill 包：包含 `jianshibao/SKILL.md`、`references/`、`scripts/`、`agents/openai.yaml`。
2. `知识库` 知识包：即本地 `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库` 目录压缩包。

放到扣子、QClaw、Workbuddy 或其他平台时，尽量保持：

```text
检视宝/
  jianshibao/
    SKILL.md
    references/
    scripts/
    agents/
知识库/
  00_总索引/
  01_部门职责与组织权限/
  02_产品与服务知识库/
  03_企业健康报告与数据分类/
  04_客户运营案例与服务SOP/
  05_IT与合规支持/
  06_方法论与模板/
  07_售前材料规范与素材库/
  90_来源追溯/
  99_QA/
```

## 安装后自检

若平台支持运行脚本，可执行：

```bash
python3 jianshibao/scripts/check_knowledge_pack.py /path/to/知识库
```

必须通过：

- 核心目录存在。
- 关键索引文件存在。
- 完整知识路由文件存在。
- 主要来源 manifest 可读。
- OCR 数量与 manifest 数量一致。

## 跨平台注意事项

- 有些平台只识别 `SKILL.md`，不识别 `agents/openai.yaml`；此时使用 `SKILL.md` 内容作为技能说明。
- 有些平台不允许本地文件读取；此时需要把 `知识库` 上传为平台知识库，并在技能说明中声明知识库名称。
- 有些平台不能联网；此时任何超出本地知识库的问题都只能标为“需联网核验/需补证”。
- 有些平台不能写文件记忆；此时把首次初始化偏好写入平台记忆或固定提示词。
