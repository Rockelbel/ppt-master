#!/usr/bin/env node
import fs from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const sourcePages = JSON.parse(await fs.readFile(`${root}/data/pages.json`, "utf8"));
const generatedPages = await fs.readFile(`${root}/.tmp/ai-generated-pages.json`, "utf8").then(JSON.parse).catch(() => []);
const pages = sourcePages
  .filter(page => page.deckId === "deck-26" && page.libraryStatus !== "excluded" && page.title !== "待补充标题" && Number(page.sourcePage || 0) <= 105)
  .sort((a, b) => Number(a.sourcePage || 0) - Number(b.sourcePage || 0));
const closingPage = generatedPages.find(page => page.id === "ai-page-benchmark-closing-20260823") || generatedPages.find(page => page.pageRole === "closing");
if (closingPage) pages.push(closingPage);

const chapterRules = [
  { id: "company", name: "公司与平台可信度", start: 3, end: 11 },
  { id: "case", name: "客户案例与合作背景", start: 12, end: 20 },
  { id: "overview", name: "整体产品与价值", start: 21, end: 31 },
  { id: "travel", name: "商旅模块", start: 33, end: 47 },
  { id: "savings", name: "降本与管控", start: 49, end: 77 },
  { id: "ai", name: "AI 与 Agent", start: 79, end: 93 },
  { id: "service", name: "服务与 SLA", start: 95, end: 105 },
];
const chapterFor = page => chapterRules.find(rule => Number(page.sourcePage) >= rule.start && Number(page.sourcePage) <= rule.end) || null;
const countWords = page => String(page.extractedText || "").replace(/\s+/g, "").length;
const chapters = chapterRules.map(rule => {
  const items = pages.filter(page => Number(page.sourcePage) >= rule.start && Number(page.sourcePage) <= rule.end);
  return {
    ...rule,
    pageCount: items.length,
    scenes: [...new Set(items.flatMap(page => page.sceneTags || []))],
    averageTextChars: items.length ? Math.round(items.reduce((sum, page) => sum + countWords(page), 0) / items.length) : 0,
    pages: items.map(page => ({ page: page.sourcePage, id: page.id, title: page.title, structure: page.structureTags || [], scenes: page.sceneTags || [] })),
  };
});
const transitions = [];
for (let index = 1; index < pages.length; index += 1) {
  const left = chapterFor(pages[index - 1]);
  const right = chapterFor(pages[index]);
  if (left && right && left.id !== right.id) transitions.push(`${left.id}->${right.id}`);
}
const transitionCounts = Object.fromEntries([...new Set(transitions)].map(key => [key, transitions.filter(item => item === key).length]));
const report = {
  deckId: "deck-26",
  sourceFile: pages[0]?.sourceFile,
  pageCount: pages.length,
  customerFacing: true,
  customerFacingEvidence: ["解决方案", "中国移动", "客户案例", "合作模式", "服务 SLA"],
  opening: pages.slice(0, 12).map(page => ({ page: page.sourcePage, title: page.title, structure: page.structureTags || [], scenes: page.sceneTags || [] })),
  chapters,
  transitions: transitionCounts,
  closing: pages.slice(-8).map(page => ({ page: page.sourcePage, title: page.title, structure: page.structureTags || [], scenes: page.sceneTags || [] })),
  qualityGates: {
    hasCover: pages.some(page => page.pageRole === "cover" || (Number(page.sourcePage) === 1 && (page.structureTags || []).includes("封面"))),
    hasContents: pages.filter(page => page.pageRole === "contents" || (page.structureTags || []).includes("目录")).map(page => page.sourcePage || page.id),
    hasChapterOpeners: pages.filter(page => page.pageRole === "chapterOpener").map(page => page.sourcePage || page.id),
    hasClosingPage: pages.some(page => page.pageRole === "closing" || (page.structureTags || []).includes("尾页")),
    missingTitlePages: pages.filter(page => !page.title || page.title === "待补充标题").map(page => page.sourcePage || page.id),
    placeholderPages: pages.filter(page => page.pageRole === "excludedPlaceholder" || /待补充|占位/.test(String(page.title || ""))).map(page => page.sourcePage || page.id),
    consecutiveDuplicateTitles: pages.slice(1).filter((page, index) => String(page.title || "") && page.title === pages[index].title).map(page => page.sourcePage || page.id),
    closingPageId: closingPage?.id || null,
  },
  generatedAt: new Date().toISOString(),
};
const output = `${root}/.tmp/sales-deck-benchmark.json`;
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  "# 销售方案基准：分贝通企业支出管理解决方案",
  "",
  `来源：${report.sourceFile}，${report.pageCount} 页。此方案按客户可演示的完整销售方案处理，不再归为内部汇报。`,
  "",
  "## 章节结构",
  "",
  ...chapters.map(chapter => `- ${chapter.start}-${chapter.end} 页：${chapter.name}，${chapter.pageCount} 页，平均文本 ${chapter.averageTextChars} 字，场景：${chapter.scenes.join("、")}`),
  "",
  "## 关键学习",
  "",
  "- 完整客户方案不是简单的 10 页拼装，而是由公司可信度、客户案例、整体价值、核心模块、差异化能力、风险与合规、AI 能力、服务保障组成的多章节叙事。",
  "- 目录页会在长方案中重复出现，用来标记章节边界；章节页承担节奏控制，不应和普通内容页混选。",
  "- 产品介绍之后需要进入具体业务模块，再进入降本、管控、合规和 AI，最后以服务与 SLA 收束。",
  "- 客户案例不是装饰页，而是把公司能力落到客户背景、合作模式、流程、结果和证言的完整证据链。",
  "- 当前自动分类把本方案误判为“项目/内部汇报”，这条规则需要修正：客户名称、解决方案、客户案例、合作模式和服务承诺共同出现时，应优先识别为“客户整体方案”。",
  "",
  "## 质量门槛",
  "",
  `- 生成页数：${report.pageCount}`,
  `- 封面：${report.qualityGates.hasCover ? "通过" : "缺失"}`,
  `- 目录页：${report.qualityGates.hasContents.join("、") || "缺失"}`,
  `- 章节页：${report.qualityGates.hasChapterOpeners.join("、") || "缺失"}`,
  `- 尾页：${report.qualityGates.hasClosingPage ? "通过" : "缺失，需要补建或明确结束页"}`,
  `- 缺少标题页：${report.qualityGates.missingTitlePages.join("、") || "无"}`,
  `- 占位页：${report.qualityGates.placeholderPages.join("、") || "无"}`,
  `- 连续重复标题：${report.qualityGates.consecutiveDuplicateTitles.join("、") || "无"}`,
  "",
  "机器可读详情见 .tmp/sales-deck-benchmark.json。",
  "",
].join("\n");
await fs.writeFile(`${root}/.tmp/sales-deck-benchmark.md`, markdown, "utf8");
console.log(output);
