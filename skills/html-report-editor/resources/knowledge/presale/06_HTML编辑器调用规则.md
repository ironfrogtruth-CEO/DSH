# HTML 编辑器调用规则

## 1. 默认调用场景

当 `html编辑器skill` 生成以下类型材料时，应加载本目录：

- 售前方案。
- 产品介绍。
- 客户合作方案。
- 运营商权益包方案。
- 地产/物业健康养老服务方案。
- 养老、智能硬件、健康宝、企康会员、企业补充医疗相关材料。

加载顺序：

1. `01_售前材料内容结构.md`：确定章节和叙事。
2. `05_产品场景与客户方案映射.md`：确定客户场景、产品组合和引用来源。
3. `02_售前视觉VI与版式规范.md`：确定视觉风格。
4. `03_样式组件与页面模板.md`：选择页面组件。
5. `curated_assets.csv`：优先查找图片素材。
6. `asset_manifest.csv` 与 `90_来源追溯/售前材料/_page_renders/`：补充素材和版式追溯。

## 2. 素材路径

知识库素材根目录：

```text
resources/knowledge/presale
```

关键文件：

```text
curated_assets.csv
curated_assets.json
asset_manifest.csv
asset_manifest.json
curated_asset_contact_sheet.jpg
asset_contact_sheet.jpg
assets/PRESALE###/PRESALE###_A####.jpeg
```

页面渲染追溯：

```text
本机完整知识库中的 `90_来源追溯/售前材料/_page_renders/PRESALE###/p###.jpg`
```

## 3. 设计调用规则

### 3.1 售前方案默认风格

- 默认采用“平安汇报模版”底层风格。
- 遇到售前/产品/客户方案，叠加“平安好医生售前方案风格”。
- 页面应更强调产品权益、客户痛点、服务流程、案例证明和履约截图。

### 3.2 CSS 变量

HTML 编辑器应可使用以下扩展变量：

```css
--pa-presale-orange: #f05a22;
--pa-presale-orange-dark: #d94d1f;
--pa-presale-orange-soft: #fff1e8;
--pa-presale-gray-bg: #f7f7f7;
--pa-presale-line: #d9dde3;
--pa-presale-ink: #222222;
--pa-presale-muted: #666666;
--pa-presale-green: #1d8153;
--pa-presale-black: #111111;
```

### 3.3 页面组件优先级

售前材料生成时优先使用：

1. `pa-presale-cover`
2. `pa-presale-toc`
3. `pa-pain-grid`
4. `pa-capability-map`
5. `pa-product-tier`
6. `pa-benefit-table`
7. `pa-flow-steps`
8. `pa-phone-grid`
9. `pa-device-showcase`
10. `pa-case-proof`
11. `pa-note-strip`

## 4. 素材标签调用规则

`curated_assets.csv` 中的 `asset_category` 为优先入口：

| asset_category | 适合用途 |
| --- | --- |
| 移动端/履约截图 | App、小程序、权益领取、健康宝履约、服务使用流程。 |
| 智能硬件/设备图 | 音箱、手表、检测设备、安防传感器、IoT 联动方案。 |
| 场景照片/插画 | 封面、行业痛点、客户场景、医生/老人/家庭服务。 |
| 图标/Logo | 能力模块、流程节点、品牌/客户生态标识。 |
| 横幅/装饰条 | 封面副视觉、章节页装饰、橙色强调条。 |
| 整页/大图版式参考 | 复刻复杂页面结构或提炼表格/流程布局。 |

额外标签：

- `operator_solution`：运营商方案。
- `real_estate_scene`：地产/社区场景。
- `smart_device`：智能硬件。
- `mobile_ui_screenshot`：移动端截图。
- `product_package`：产品/权益包。
- `service_flow`：履约/流程。
- `case_reference`：案例页素材。
- `medical_service`：医疗服务场景。

## 5. 输出检查规则

生成前：

- 识别客户类型和材料目的。
- 查找本地知识库是否已有产品、案例、数据依据。
- 明确是否需要引用外部最新资料。

生成中：

- 每个产品/权益页都要有来源或注释。
- 每个案例页都要有来源编号。
- 每个流程页都要有步骤编号和动作名称。
- 每个图片素材都应保留素材编号或来源说明，便于回溯。

生成后：

- 检查是否保留页码、注释、服务范围、等待期、免责声明。
- 检查图片是否变形，手机截图优先 `object-fit: contain`。
- 检查外发风险：客户商标、人物肖像、第三方品牌、价格和资源数量。
- 若素材来自本库，记录 `PRESALE###_A####` 或 `PRESALE### p##`。

## 6. 禁止事项

- 禁止脱离知识库编造资源数量、价格、案例成效。
- 禁止把售前方案做成纯营销海报。
- 禁止只生成标题和口号，不给产品明细、流程和落地动作。
- 禁止删除原始售前材料源文件；迁移环境中若无源文件，以本便携知识库和素材库为准。
