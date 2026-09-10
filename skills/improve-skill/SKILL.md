---
name: improve-skill
description: 把技能评估发现转成一份具体的改写简报；用户已评估某技能、现在要改进它（尤其问过先修什么）时用它。
compatibility: Ported from Codex plugin plugin-eval (https://openai.com/), license MIT.
allowed-tools: Bash
---

# Improve Skill

Use this skill after `plugin-eval` has already produced findings for a local skill.

## Workflow

1. Run `plugin-eval analyze <skill-path> --brief-out <brief.json>`.
2. Read the improvement brief and group work into required fixes versus recommended fixes.
3. Apply the `skill-creator` guidance from `/Users/benlesh/.codex/skills/skill-creator/SKILL.md`.
4. Re-run the evaluation and compare before and after outputs.

## Chat Requests To Recognize

- `Improve this skill based on the evaluation.`
- `Rewrite this skill using the plugin-eval findings.`
- `What should I fix first in this skill?`

## Focus Areas

- reduce trigger and invoke token costs
- keep `SKILL.md` compact
- move bulky details into references or scripts
- improve trigger descriptions
- fix broken links and manifest/frontmatter issues

## Commands

```bash
plugin-eval analyze <skill-path> --brief-out ./skill-brief.json
plugin-eval compare before.json after.json
```

## Reference

- `../../references/chat-first-workflows.md`
