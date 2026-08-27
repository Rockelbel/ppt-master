#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pagesPath = path.join(root, "data", "pages.json");
const pages = JSON.parse(await fs.readFile(pagesPath, "utf8"));

const chapterRanges = [
  { id: "company", title: "公司与平台可信度", start: 3, end: 11 },
  { id: "case", title: "客户案例与合作背景", start: 12, end: 20 },
  { id: "overview", title: "整体产品与价值", start: 21, end: 31 },
  { id: "travel", title: "商旅模块", start: 33, end: 47 },
  { id: "savings", title: "降本、管控与合规", start: 49, end: 77 },
  { id: "ai", title: "AI 与 Agent", start: 79, end: 93 },
  { id: "service", title: "服务与 SLA", start: 95, end: 105 },
];

function genericRole(page) {
  const title = String(page.title || "");
  const structure = page.structureTags || [];
  if (structure.includes("尾页")) return "closing";
  if (structure.includes("目录")) return "contents";
  if (structure.includes("封面")) return "chapterOpener";
  if (/客户案例|客户证言|案例/.test(title) || (page.sceneTags || []).includes("客户案例")) return "caseStudy";
  if (/服务|SLA|客服|管家/.test(title) || (page.sceneTags || []).includes("服务")) return "service";
  if (/合规|管控|降本|风控/.test(title) || (page.sceneTags || []).some(tag => ["合规", "管控", "降本"].includes(tag))) return "controlCompliance";
  if (/AI|Agent|智能|Skills/.test(title) || (page.sceneTags || []).some(tag => ["AI", "Agent"].includes(tag))) return "aiAgent";
  if (/产品|平台|功能|模块|资源|能力/.test(title) || (page.sceneTags || []).includes("产品介绍")) return "moduleOverview";
  return "content";
}

function deck26Role(page) {
  const n = Number(page.sourcePage || 0);
  if (n === 1) return "cover";
  if ([2, 32, 48, 78, 94].includes(n)) return "contents";
  if (n === 106 || page.title === "待补充标题") return "excludedPlaceholder";
  if ([12, 13, 33, 50, 95, 103].includes(n)) return "chapterOpener";
  if (n === 11) return "customerContext";
  if ([14, 15, 16, 17, 18, 19, 20].includes(n)) return "caseStudy";
  if (n >= 3 && n <= 10) return "companyCredibility";
  if (n >= 21 && n <= 31) return n === 21 ? "solutionOverview" : "moduleOverview";
  if (n >= 34 && n <= 47) return "moduleDetail";
  if (n >= 49 && n <= 56) return "valueProof";
  if (n >= 57 && n <= 60) return "controlCompliance";
  if (n === 61) return "caseStudy";
  if (n >= 62 && n <= 69) return "moduleDetail";
  if (n >= 70 && n <= 77) return "controlCompliance";
  if (n >= 79 && n <= 93) return "aiAgent";
  if (n >= 96 && n <= 102) return "service";
  if (n >= 104 && n <= 105) return "service";
  return genericRole(page);
}

const roleCounts = {};
const chapterCounts = {};
for (const page of pages) {
  const pageRole = page.deckId === "deck-26" ? deck26Role(page) : genericRole(page);
  const chapter = page.deckId === "deck-26"
    ? chapterRanges.find(item => Number(page.sourcePage) >= item.start && Number(page.sourcePage) <= item.end)
    : null;
  page.pageRole = pageRole;
  page.roleSource = page.deckId === "deck-26" ? "benchmark-rule-v1" : "structure-title-scene-v1";
  if (chapter) {
    page.chapterId = chapter.id;
    page.chapterTitle = chapter.title;
    chapterCounts[chapter.id] = (chapterCounts[chapter.id] || 0) + 1;
  } else {
    delete page.chapterId;
    delete page.chapterTitle;
  }
  roleCounts[pageRole] = (roleCounts[pageRole] || 0) + 1;
}

await fs.writeFile(pagesPath, `${JSON.stringify(pages, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(root, "data", "pages.js"), `window.REAL_PAGES = ${JSON.stringify(pages)};\n`, "utf8");
await fs.writeFile(path.join(root, "data", "page-role-summary.json"), `${JSON.stringify({ version: "page-role-v1", generatedAt: new Date().toISOString(), roleCounts, chapterCounts, roles: ["cover", "contents", "chapterOpener", "customerContext", "caseStudy", "companyCredibility", "solutionOverview", "moduleOverview", "moduleDetail", "valueProof", "controlCompliance", "aiAgent", "service", "closing", "content", "excludedPlaceholder"] }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ pages: pages.length, roleCounts, chapterCounts }));
