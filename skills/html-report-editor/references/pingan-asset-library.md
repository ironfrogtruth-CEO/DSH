# 平安好医生 HTML 素材库调用规则

## 1. 素材库位置

便携素材库：

```text
resources/pingan-materials
```

机器索引：

```text
resources/pingan-materials/99_索引与说明/html_asset_map.json
resources/pingan-materials/99_索引与说明/asset_manifest.json
```

人工预览：

```text
resources/pingan-materials/99_索引与说明/contact_sheet.html
resources/pingan-materials/99_索引与说明/contact_sheet_full.png
```

## 2. 默认调用原则

- 售前、产品、客户方案类 HTML 材料优先读取 `html_asset_map.json`。
- 默认只调用 `safe_for_external=true`、`pa_style_score>=4`、`html_usage=default_candidate` 的素材。
- `iconfont_public_search` 素材统一标记为 `needs_review_iconfont`，只作候选，不默认外发。
- `06_版式参考_不直接入页` 只用于观察版式，不直接作为页面视觉元素。

## 3. HTML 标记规范

图片元素必须保留资产标识：

```html
<img
  class="pa-asset-icon"
  src="resources/pingan-materials/01_图标_icon/服务能力/pa_icon_vaccine_syringe.svg"
  data-asset-id="gen.icon_vaccine_syringe"
  data-replacement-group="service.vaccine"
  alt="疫苗接种"
>
```

场景图和设备图建议使用：

```html
<img
  class="pa-asset-image contain"
  src="resources/pingan-materials/04_设备产品图/智能音箱/local_PRESALE001_A0025_智能音箱.jpeg"
  data-asset-id="local.PRESALE001_A0025"
  data-replacement-group="device.speaker"
  alt="智能音箱"
>
```

## 4. 常用替换组

- `service.vaccine`：疫苗接种。
- `service.health_record`：健康档案。
- `service.report`：报告解读。
- `service.checkup`：体检筛查。
- `service.cardio`：心脑血管。
- `service.sleep`：睡眠管理。
- `service.nutrition`：营养管理。
- `medical.doctor`：医生服务。
- `medical.hospital`：医院资源。
- `medical.bed`：住院床位。
- `medical.surgery`：手术协助。
- `medical.companion`：陪诊服务。
- `device.speaker`：智能音箱。
- `device.medicine_box`：药箱药品。
- `proof.app_screenshot`：履约截图。
- `flow.arrow_right`：右箭头。
- `flow.closed_loop`：闭环箭头。
- `background.medical_tech`：医疗科技背景。

## 5. 风格边界

- 图标统一用平安橙、黑灰、白底、少量健康绿。
- 不使用五颜六色、emoji 风、儿童卡通风素材。
- 不使用来源不清、客户 logo 明显、旧品牌文案明显的素材。
- 手机截图只用于履约证明或产品路径展示，不作为装饰图。
