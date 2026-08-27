# PPT Master

基于企业真实 PPT 模板的销售方案页面资产库与 AI 生成工作台。

PPT Master 面向销售、售前和方案团队，解决“每次从零拼方案、难以复用既有页面、AI 不理解公司内部组织方式”的问题。系统把已有 PPT 按页面级拆成可检索资产，保留原始版式、字体、颜色和可编辑对象；销售可以按结构标签和业务场景快速筛选页面，拖拽组成预览，再导出指定顺序的可编辑 PPTX。左侧 AI 对话支持普通问答、引用指定页面改写，以及后续扩展为整套方案生成和客户化改稿。

## 产品流程

```text
准备企业 PPT
    ↓
上传或放入本地素材目录
    ↓
异步拆页，读取 PPTX XML 中的标题、全部文字和版式证据
    ↓
规则预标注 + DeepSeek 标签建议
    ↓
人工确认结构标签、场景标签、关键词和描述
    ↓
按标签/关键词筛选页面，加入右侧预览
    ↓
拖拽调整页面顺序
    ↓
在线放映，或导出原始可编辑 PPTX
    ↓
通过 AI 引用某页进行内容改写，生成新的页面草稿
```

## 当前能力

- 页面级资源库：标题、结构标签、场景标签、描述和原始文本。
- PPTX 内部 XML 提取：识别顶部标题，并保留文本框位置、字号和占位符信息。
- 多文件导入：异步任务记录、进度、页数、提取结果、重复提示和失败信息。
- DeepSeek 服务端调用：API Key 只在服务端读取，不发送到浏览器。
- 右侧预览队列：添加、移除、清空、拖拽排序、展开收起和放映模式。
- 在线预览：按当前页面顺序展示选中的页面，并支持复制预览链接。
- 可编辑 PPTX 导出：复用源 PPT 的页面结构，不把页面降级为图片。
- AI 引用改写：从资源库卡片添加到对话，生成新页面，原页面保持不变。
- 任务日志：记录任务规格、阶段、重试、模型响应和失败原因，便于排查。
- 客户化改稿基础能力：支持上传客户方案、生成保留/改写/待确认/删除计划。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- Python 3.10 或更高版本
- LibreOffice 或项目运行环境提供的 PPTX 渲染能力（仅在生成缩略图时需要）
- 可选：DeepSeek API Key

### 初始化

```bash
git clone https://github.com/<your-account>/ppt-master.git
cd ppt-master
node tools/init_workspace.mjs
cp .env.example .env
```

然后编辑 `.env`：

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your-key
DEEPSEEK_MODEL=deepseek-v4-flash
AGENT_PAGE_MAX_TOKENS=1800
```

不配置 API Key 也可以使用资源库、人工标注、预览和 PPTX 导出；AI 标注和 AI 改写会提示配置缺失。

### 导入企业素材

有两种方式：

1. 将 `.pptx` 文件放入 `source_ppts/`，运行 `python3 tools/build_inventory.py` 生成索引和缩略图。
2. 启动服务后，在网页右上角点击“导入 PPT”，通过导入记录页上传文件。服务会异步拆页并保存结果。

本项目默认不上传任何企业素材。`source_ppts/`、页面图片、运行时数据和导出文件均已加入 `.gitignore`。

### 启动服务

```bash
PORT=4312 node server.mjs
```

打开 http://127.0.0.1:4312。局域网使用时，将 `127.0.0.1` 替换为本机局域网 IP，并确保防火墙允许该端口。

## AI 使用方式

AI 只在识别为明确工作流时执行页面选择或生成。普通能力咨询会直接回答，不会修改右侧预览。

引用页面改写示例：

```text
在资源库卡片上选择“添加到对话”，输入：
修改标题，以及正文的内容，标题缩短点，正文再扩充一点
```

模型必须返回结构化页面内容。若模型返回空内容、JSON 不完整或不符合用户的修改约束，任务会失败，原页面和右侧预览都不会被修改。所有重试和失败原因写入 `.tmp/ai-generation-debug.jsonl` 与 `.tmp/agent-flow.jsonl`。

## 开发与验证

```bash
node --check server.mjs
node --check app.js
node tools/task_spec.mjs
node tools/test_reference_page_validation.mjs
for test in tools/test_*.mjs; do node "$test" || exit $?; done
```

与 PPTX 相关的工具使用真实源文件，并尽量保留原始页面的母版、布局、文本框和图片对象。生成或导出后可以用 `tools/merge_editable_decks.mjs`、`tools/render_resilient.mjs` 和项目内的检查脚本验证 PPTX 完整性与可编辑文本。

## 数据与隐私

公开仓库只包含应用代码、工具脚本、空目录占位文件和标签枚举示例。以下内容默认仅保存在本机：

- `.env` 与所有 API Key
- `source_ppts/` 中的企业原始 PPT
- `assets/pages/` 中的逐页截图
- `data/` 中由企业素材生成的页面索引、公司知识和飞书资料
- `.tmp/` 中的会话、任务、模型日志和生成页面
- `output/` 中的 PPTX、预览图和客户化改稿结果

如果 API Key 曾经出现在聊天记录、日志或公开仓库中，请立即在模型服务商控制台轮换，不要继续复用。

## 文档

- [PRD.md](./PRD.md)：产品目标、MVP 范围与验收标准
- [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)：PMF 假设、开发计划与迭代方向
- [ARCHITECTURE.md](./ARCHITECTURE.md)：数据模型与接口边界
- [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md)：本地开发记录与问题修复历史
- [AGENT_TOOLS.md](./AGENT_TOOLS.md)：Agent、飞书和外部工具接入说明

## 路线图

下一阶段重点是完善基于公司真实页面顺序的方案结构学习、引用页多轮修改、页面重复候选提示、长任务可恢复执行、更多外部资料工具，以及整套销售方案的生成和客户化改写质量门禁。

## License

MIT。企业 PPT、客户资料、飞书文档和模型密钥不属于本许可证授权范围，请在获得相应权利后使用。
