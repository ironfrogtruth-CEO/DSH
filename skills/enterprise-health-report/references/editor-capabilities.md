# 编辑器能力

## 必须支持

- 当前页插入自由图片。
- 插入图片可拖拽、8 点缩放、删除。
- 图片可设置宽、高、适配方式、透明度、层级。
- 图片区域不显示边框、虚线或占位背景。
- 每页可替换顶部/底部/背景/页脚图片层。
- 图片替换必须同时支持三条入口：双击图片、选中后点击工具栏“替换”、点击工具栏“顶图/页脚”。
- 替换对象必须覆盖普通 `<img>`、报告解读医生图、到企/到店/到线照片、自由插入图片、CSS 背景图片区、顶部图层和页脚图层。
- 文件选择器必须由统一入口触发；每次触发前清空 input value，确保用户连续选择同一张图片也能触发替换。
- 页脚图片层尺寸固定为 `793px × 300px`。
- 页脚图片支持上下透明度控制，形成自下而上的线性渐隐。
- 打印/PDF 时隐藏工具栏、选中框、缩放点、辅助标签。

## 工具栏控件

推荐控件 ID：

- `toggleEdit`
- `selectedInfo`
- `addText`
- `addImage`
- `setFooterImage`
- `triggerReplace`
- `imageFit`
- `imageOpacity`
- `widgetWidth`
- `widgetHeight`
- `footerTopOpacity`
- `footerBottomOpacity`
- `bringForward`
- `sendBackward`
- `deleteSelected`
- `saveHtml`
- `printPdf`

## 插入图片模型

插入图片必须创建外层容器，而不是直接插入裸 `<img>`：

```html
<div class="image-widget moveable" data-component="free-image"
  style="left:90px;top:220px;width:260px;height:160px;z-index:12">
  <img class="free-image" src="..." alt="新增图片">
</div>
```

缩放点绑定到外层 `.image-widget`，这样空元素、图片元素和浏览器默认图片行为不会破坏缩放。

## 移动组件

拖动普通组件前，应把组件转为绝对定位，并插入不可见占位元素，避免周边模块 reflow 偏移。删除组件时同步删除占位元素。

## 图片替换 QA

出稿前必须用浏览器实测，而不是只检查按钮存在：

- 选中现场照片后点击“替换”，图片 `src` 或 `background-image` 必须更新。
- 双击现场照片或报告解读医生图，必须唤起图片文件选择器并完成替换。
- 点击“顶图”后替换图片，所有普通页 `.top-image-slot` 必须同步更新。
- 点击“页脚”后替换图片，所有普通页 `.page-footer-slot` 必须同步更新。
- 点击“图片”插入自由图片后，新图片必须可拖拽、缩放、替换和删除。
