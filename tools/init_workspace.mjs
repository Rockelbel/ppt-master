#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await Promise.all(["source_ppts", "assets/pages", "output", ".tmp", "data"].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
const defaults = {
  "pages.json": [],
  "pages.js": "window.REAL_PAGES = [];\n",
  "decks.json": [],
  "source-metadata.json": {},
  "source-registry.json": [],
  "template-contract.json": { version: 1, templates: [] },
  "ppt-patterns.json": {},
  "page-role-summary.json": {},
  "quality-report.json": {},
  "company-knowledge.json": {},
  "feishu-documents.json": [],
};
for (const [name, value] of Object.entries(defaults)) {
  const target = path.join(root, "data", name);
  try { await fs.access(target); }
  catch { await fs.writeFile(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
}
const tags = path.join(root, "data", "tag-enums.json");
try { await fs.access(tags); }
catch { await fs.writeFile(tags, `${JSON.stringify({ structure: ["封面", "目录", "内容", "尾页"], scene: [] }, null, 2)}\n`, "utf8"); }
const knowledge = path.join(root, "PPT_KNOWLEDGE.md");
try { await fs.access(knowledge); }
catch { await fs.writeFile(knowledge, "# Local PPT knowledge\n\nRun the inventory and pattern-analysis tools after adding your private decks.\n", "utf8"); }
console.log("Workspace initialized. Add private decks to source_ppts/ or upload them from the web app.");
