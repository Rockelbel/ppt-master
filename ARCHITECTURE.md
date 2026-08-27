# MVP 技术边界与接口契约

## 页面数据模型

```json
{
  "id": "page_001",
  "sourceType": "imported",
  "sourceFileId": "file_001",
  "sourcePage": 3,
  "previewUrl": "/assets/file_001/page-003.png",
  "extractedText": "页面原始文本",
  "pageType": "案例",
  "scenarios": ["首次拜访", "行业案例"],
  "keywords": ["制造业", "降本", "自动化"],
  "takeaway": "一句话核心结论",
  "aiConfidence": 0.91,
  "reviewStatus": "pending",
  "libraryStatus": "active",
  "usageCount": 0,
  "notSuitableCount": 0,
  "version": 1
}
```

`sourceType` currently uses `imported` for pages extracted from uploaded PPT/PPTX files. When an Agent-generated page is explicitly added to the asset library, it uses `ai-generated` and should additionally retain `sourceTaskId`, `sourceModel`, `sourcePrompt` (or a redacted prompt reference), `sourceTemplatePageId` when applicable, and `generatedAt`. An AI-generated draft that has not been added to the library remains task output and does not enter the reusable asset set.

## 解析服务契约

`POST /api/imports` 接收 `.pptx` / `.ppt` 并返回 `{ importId, fileName, status: "queued" }`。

`GET /api/imports/:id` 返回任务状态、页数、失败页和页面记录。

`POST /api/pages/:id/annotate` 接收页面文本、版式摘要和图片描述，返回严格 JSON 标签。

`POST /api/drafts` 接收标题、提纲和页面 ID 顺序，返回 HTML 草稿地址和版本号。

## AI 适配器

不要在浏览器直接调用模型。服务端适配器读取：

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
```

提示词要求模型只返回 JSON，无法判断时返回 `null` 和低置信度；人工确认是最终事实来源。

## 状态流

`uploaded → extracting → labeling → review → active`

失败可进入 `failed` 并重试；页面不做物理删除，弃用使用 `libraryStatus=deprecated`。
