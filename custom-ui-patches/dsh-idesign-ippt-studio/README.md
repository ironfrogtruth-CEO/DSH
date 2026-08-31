# deepseek-idesign / deepseek-ippt Studio 品牌与导出修复补丁

修改日期:2026-08-31
适用:profiles/web/node_modules 下 deepseek-idesign、deepseek-ippt 两包的 studio/dist/assets/*.js
安装版本:deepseek-idesign@0.2.2、deepseek-ippt@0.1.2(升级后需按本文重新应用)

## 一、品牌文案(两个 Studio 左上角)

| 位置 | 原值 | 新值 |
| --- | --- | --- |
| Design Studio(idesign)标题 | `iDesign` | `HTML` |
| PPT Studio(ippt)标题 | `iPPT` | `皮皮虾` |
| 两处副标题 | `by iPolloWork` | `by ShrimpTank` |

实现:替换 bundle 内 branding 配置对象(每处唯一字符串):
- idesign: `title:"iDesign"` → `title:"HTML"`;`byline:"by iPolloWork"` → `byline:"by ShrimpTank"`
- ippt: `title:"iPPT"` → `title:"皮皮虾"`;`byline:"by iPolloWork"` → `byline:"by ShrimpTank"`

logo 图标保留原样(用户确认不再替换虾缸 logo)。

## 二、模板 Logo 与缩略图缓存

- PPT 4 套、Design 21 套内置模板统一恢复包内原始 `ipollowork-logo.svg`，不再把虾缸 PNG 包进大尺寸 SVG。
- 每个模板继续使用原有 `.ipw-brand-slot img { width:18px; height:18px }`，位置和尺寸由模板自身控制。
- Logo 引用使用 `v=20260831-logo-fix-1`，避免浏览器继续读取已缓存的巨型图标。
- 模板封面请求带上 `manifest.version`；平安好医生模板升级到 `1.2.1` 后，缩略图 URL 随版本变化。
- Host 的模板封面响应使用 `cache-control:no-store`，更新后不再保留 24 小时旧封面。

## 三、PPTX 导出修复(span not covered 中止)

现象:
```
PPTX export stopped because 3 visible visual element(s) are not covered: span, span, span.
No incomplete presentation was created.
```

根因:导出规划函数 `tVe` 只把 `h1-h6/p/li`(及纯文本叶子)规划为文本框,
纯文本 `<span>` 不被规划;而可见性校验 `eKe`/`oVe` 会把 span 计入
`visibleVisualElementCount`,导致 covered < visible,fail-loud 中止整个导出。

修复(两个 bundle 同一处,唯一上下文串):
```js
// 原
l.matches("h1,h2,h3,h4,h5,h6,p,li")||l8(l)&&l.children.length===0){l.innerText.trim()
// 新
l.matches("h1,h2,h3,h4,h5,h6,p,li,span,strong,b,em,i,small,sub,sup")||l8(l)&&l.children.length===0){l.innerText.trim()
```
效果:独立文本 span 会被规划为文本框并计入覆盖;位于已规划文本(h1/p/li 等)
内部的 span 不会被重复访问,行为不变。`aVe`(视觉设计判定)未改动。

## 四、文件与备份

- 修改文件:
  - `node_modules/deepseek-idesign/studio/dist/assets/index-DL8JJYJS.js`
  - `node_modules/deepseek-ippt/studio/dist/assets/index-CtffV1H5.js`
- 本目录:
  - `original/` — 修改前的原始 bundle(回滚用)
  - `modified/` — 修改后的 bundle(升级后重新应用用)

## 五、回滚 / 重放

```bash
# 回滚
cp original/idesign-index.js <install>/profiles/web/node_modules/deepseek-idesign/studio/dist/assets/index-DL8JJYJS.js
cp original/ippt-index.js   <install>/profiles/web/node_modules/deepseek-ippt/studio/dist/assets/index-CtffV1H5.js

# 升级后重放(先校验版本,勿直接覆盖)
cp modified/idesign-index.js <install>/profiles/web/node_modules/deepseek-idesign/studio/dist/assets/index-DL8JJYJS.js
cp modified/ippt-index.js   <install>/profiles/web/node_modules/deepseek-ippt/studio/dist/assets/index-CtffV1H5.js
```

改动为纯静态资源,浏览器刷新即生效,无需重启服务。
