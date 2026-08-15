# 企业健康报告组件系统

## 页面结构

每页先定焦点，再选组件：

| 信息形态 | 推荐组件 | 注意事项 |
| --- | --- | --- |
| 年度变化 | slope/dumbbell/before-after/waterfall | 圆形内数字必须完整居中；同比下降不使用绿色代表“低风险” |
| 风险占比 | risk proportion / red bar / ranked bars | 高风险用红橙，不放在绿色安全轴上 |
| 服务路径 | flow / timeline / service matrix | 写清员工入口、企业动作、平安服务响应 |
| 体检异常排行 | bar panel / heat matrix | 把指标归入慢病、呼吸、肌骨、女性专项等主线 |
| 双端验证 | dual-proof + CSS arrow | 箭头必须限制在组件内，禁止溢出页面 |
| 现场/服务证据 | evidence split / photo collage | 使用真实且主题匹配的图片，不用占位图 |
| 结论收束 | conclusion strip | 结论必须自然、业务化，不写“领导可读结论” |

## 组件命名

生成 HTML 时优先使用以下类名：

- `.metric-grid`, `.metric-card`
- `.flow`, `.flow-step`
- `.insight-grid`, `.insight-card`
- `.risk-proportion`
- `.dual-proof`, `.proof-arrow`
- `.evidence-split`
- `.conclusion`
- `.concept-note`
- `.page-footer-slot`

## 底部设计

A4 报告默认保留 `793px × 300px` 页脚图片层：

```html
<div class="page-footer-slot editable-image-layer"
  data-layer="pageFooter"
  data-editor-name="P2 页脚图片层"
  style="--footer-bottom-opacity:.65;--footer-top-opacity:0"></div>
```

页脚图片层只用于真实素材或用户后续替换，不用于占位图。解读框应放在最后一个正文组件后方；统计口径、来源和医学边界注释固定在页面左下角，不跟随解读框移动。

## 文案规则

底部解释卡片不得每页机械重复“异常成因 / 进一步风险 / 缓解动作 / 服务响应”。按页面内容改写：

- 改善页：年度成效、已有基础、持续跟踪、口径延续。
- 风险页：结构判断、交叉验证、事件风险、专项动作、服务配置。
- 服务页：现场价值、感知提升、活动主题、平安服务。
- 配置页：配置逻辑、落地要求、年度组合、边界说明。

## 风险颜色

绿色只能表达改善、安全、低风险或服务成效。若数值含义是“高风险人群占比”“高风险均值”“事件风险”，使用红/橙和明确说明，避免让读者以为绿色区域代表风险较低。
