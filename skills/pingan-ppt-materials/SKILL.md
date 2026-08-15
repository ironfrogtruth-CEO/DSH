---
name: pingan-ppt-materials
description: Create or revise Ping An enterprise health PowerPoint/Google Slides materials through the presentations plugin while enforcing the local knowledge base, Ping An visual style, page blueprints, service/product terminology, source references, QA Gate, and the single output root /Users/marcus/Desktop/平安企康/03_产物交付. Use for 平安企康 PPT, 述标材料, 客户方案, 产品介绍, 服务书, 医健付/企业医务室 decks, or whenever the user asks to use the PPT plugin with Ping An style and local KB content.
---

# Ping An PPT Materials

Use this skill as the bridge between `平安健康知识库&技能` and the official `presentations` plugin. It prepares the page plan, brand/style rules, terminology, source references, output path, and QA Gate before native PPTX or Google Slides generation.

## Default Paths

- Workspace: `/Users/marcus/Desktop/平安企康`
- Knowledge and skill entry: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能`
- Knowledge base: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库`
- PPT master rule: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库/07_售前材料规范与素材库/09_平安系PPT母版与页面蓝图_20260625.md`
- Path rule: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/00_主入口_知识技能与产物路径规范.md`
- Output root: `/Users/marcus/Desktop/平安企康/03_产物交付`

## Route

1. Use `pingan-kb-curator` first only when new source materials need to be internalized into the knowledge base.
2. Use this skill for native `.pptx` or Google Slides work.
3. Use `pingan-html-materials` only for editable 16:9 HTML/PDF-like slide pages.
4. Use `enterprise-health-report` only for A4 employee health report production.

## Required Knowledge Load

Before calling the `presentations` plugin, read:

1. `平安健康知识库&技能/00_主入口_知识技能与产物路径规范.md`
2. `知识库/00_总索引/分类目录索引.md`
3. `知识库/00_总索引/实体索引.csv`
4. `知识库/00_总索引/关系索引.csv`
5. `知识库/07_售前材料规范与素材库/09_平安系PPT母版与页面蓝图_20260625.md`
6. `知识库/07_售前材料规范与素材库/08_企康通下载材料风格规范_20260625.md`

For Qikang, Yijianfu, workplace clinic, tender, or service-book decks, also read:

- `知识库/06_方法论与模板/企康述标与服务书方法论_20260625.md`
- `知识库/02_产品与服务知识库/企康通下载产品与服务内化_20260625.md`
- `知识库/04_客户运营案例与服务SOP/企康通下载履约实施SOP_20260625.md`
- `知识库/05_IT与合规支持/企康业务合规目录3与插旗规则.md` when compliance or business boundaries are involved.

## Output Contract

Final files must be written under:

```text
/Users/marcus/Desktop/平安企康/03_产物交付/{项目类型}/{项目名_YYYYMMDD}/
```

For PPT materials, the default project type is `产品方案PPT`. If the deck is part of a data analysis report, medicine chest project, enterprise report, or magazine monthly report, use that project type instead.

Project app `outputs/` directories are staging only. Final answers should cite only the `03_产物交付` path.

## Page Plan Contract

Create a page plan before authoring slides. Every page must carry:

- `page_id`
- `page_type`
- `page_goal`
- `audience`
- `knowledge_mode`
- `required_kb_paths`
- `entity_refs`
- `relation_refs`
- `source_refs`
- `truth_status`: `verified`, `needs_review`, `internal_only`, or `blocked`
- `layout_blueprint`
- `copy_pattern`
- `component_plan`
- `density_target`
- `qa_gate`

If a page has no clear goal, no main component, or no source basis for formal claims, block generation and return to planning.

## QA Gate

Block final delivery and roll back to plan or execute if any gate fails:

- Final output path is outside `03_产物交付/{项目类型}/`.
- Product/service name not found in Wiki or entity index.
- Unsupported prices, service counts, city coverage, medical claims, or case outcomes.
- Missing `source_refs` or `needs_review` flags for formal claims.
- Empty slide with only a title or slogan.
- PPT plugin overlap warning ignored or previews not inspected.
- Raw source document names, raw source paths, personal identifiers, UM, emails, or phone numbers in customer-facing copy.
