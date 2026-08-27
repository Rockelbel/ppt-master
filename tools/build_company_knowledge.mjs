#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const input = JSON.parse(await fs.readFile(path.join(root, "data", "feishu-documents.json"), "utf8"));
const categories = {
  product_overview: [/AI产品介绍/, /AI产品说明/, /产品功能及降本/, /Agent产品架构/],
  travel_agent: [/商旅Agent/, /商旅.*介绍/, /商旅.*操作手册/, /AI 质量白皮书/],
  control_and_expense: [/管控Agent/, /费控/, /AI审批/, /报销Agent/, /降本/],
  sales_method: [/黄宝书/, /效能包/, /销售BU/, /销售方案/, /产品功能及降本/],
  service_and_sla: [/服务等级协议/, /服务/, /质量白皮书/],
  cases_and_customer: [/客户案例/, /客户/, /蓝箭航天/],
  agent_strategy: [/Agent产品架构/, /Agent产品拆分/, /Agent接入豆包/, /AI功能成熟度/],
};
const clean = text => String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
function extractSections(content, maxChars = 10000) {
  const lines = clean(content).split("\n");
  const selected = [];
  let chars = 0;
  for (const line of lines) {
    const value = line.trim();
    if (!value || /^\|.*\|$/.test(value) || /^!\[/.test(value)) continue;
    if (/^#{1,4}\s/.test(value) || /^(产品介绍|核心功能|适用场景|场景案例|总结|结论|服务可用性|服务等级指标)/.test(value)) {
      if (chars + value.length + 1 <= maxChars) { selected.push(value); chars += value.length + 1; }
      continue;
    }
    if (selected.length && chars + value.length + 1 <= maxChars && value.length >= 12) { selected.push(value); chars += value.length + 1; }
  }
  return selected.join("\n").slice(0, maxChars);
}
const docs = input.documents || [];
const buckets = {};
for (const [category, patterns] of Object.entries(categories)) {
  const selected = docs.filter(doc => patterns.some(pattern => pattern.test(doc.title))).sort((a, b) => b.score - a.score).slice(0, 8);
  buckets[category] = selected.map(doc => ({
    sourceId: doc.token,
    title: doc.title,
    url: doc.url,
    revisionId: doc.revisionId,
    updateTime: doc.updateTime,
    sourceType: "feishu-doc",
    summary: doc.summary,
    headingsAndEvidence: extractSections(doc.content),
  }));
}
const sourceCount = new Set(Object.values(buckets).flat().map(doc => doc.sourceId)).size;
const output = {
  version: "company-knowledge-v1",
  generatedAt: new Date().toISOString(),
  sourceRegistry: "data/source-registry.json",
  sourceCount,
  usageRules: [
    "飞书文档用于产品事实、术语、能力边界、服务口径和销售话术；每条对客事实必须保留来源文档和版本。",
    "现有 PPT 用于页面角色、章节顺序、版式和视觉模板；不能用飞书文档替代页面资产。",
    "研发 PRD、市场调研和内部周报默认不能直接作为对客事实，除非任务明确要求内部方案。",
    "事实冲突时优先使用更新时间最新且明确标记为销售/对客材料的来源，并在任务日志中记录冲突。",
  ],
  productTaxonomy: ["商旅Agent", "管控Agent", "AI审批", "报销Agent", "AI选择", "AI砍价", "商旅费控BI", "企业支出管理", "服务与SLA"],
  buckets,
};
await fs.writeFile(path.join(root, "data", "company-knowledge.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: "data/company-knowledge.json", sourceCount, buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])) }));
