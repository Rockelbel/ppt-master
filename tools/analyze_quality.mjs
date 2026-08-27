#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pages = JSON.parse(await fs.readFile(path.join(root, "data/pages.json"), "utf8"));

const clean = value => String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
const shingles = value => {
  const text = clean(value);
  const output = new Set();
  for (let index = 0; index < text.length - 1; index += 1) output.add(text.slice(index, index + 2));
  return output;
};
const jaccard = (left, right) => {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};
const pageRef = page => ({
  id: page.id,
  title: page.title || "待补充标题",
  sourceFile: page.sourceFile || "",
  sourcePage: page.sourcePage || page.page || null,
  preview: page.preview || "",
});

const refs = pages.map(page => ({
  page,
  titleKey: clean(page.title),
  textKey: clean(page.extractedText || page.allText || page.title),
  textShingles: shingles(page.extractedText || page.allText || page.title),
}));
const groups = [];
const seen = new Set();
const addGroup = (score, reason, left, right) => {
  const ids = [left.page.id, right.page.id].sort();
  const key = ids.join("|");
  if (seen.has(key)) return;
  seen.add(key);
  groups.push({ score: Number(score.toFixed(3)), reason, pages: [pageRef(left.page), pageRef(right.page)] });
};

// ponytail: O(n^2) is sufficient for the current 444-page inventory; move to an index when this exceeds a few thousand pages.
for (let leftIndex = 0; leftIndex < refs.length; leftIndex += 1) {
  const left = refs[leftIndex];
  for (let rightIndex = leftIndex + 1; rightIndex < refs.length; rightIndex += 1) {
    const right = refs[rightIndex];
    if (left.textKey.length >= 12 && left.textKey === right.textKey) {
      addGroup(1, "页面文本完全相同", left, right);
      continue;
    }
    if (!left.titleKey || left.titleKey !== right.titleKey || left.textShingles.size < 8 || right.textShingles.size < 8) continue;
    const score = jaccard(left.textShingles, right.textShingles);
    if (score >= 0.78) addGroup(score, "标题相同且正文高度相似", left, right);
  }
}

const imageHashes = new Map();
for (const page of pages) {
  if (!page.preview) continue;
  try {
    const file = await fs.readFile(path.join(root, page.preview));
    const hash = crypto.createHash("sha1").update(file).digest("hex");
    const list = imageHashes.get(hash) || [];
    list.push(page);
    imageHashes.set(hash, list);
  } catch {}
}
for (const list of imageHashes.values()) {
  if (list.length < 2) continue;
  for (let index = 1; index < list.length; index += 1) addGroup(1, "页面预览图完全相同", { page: list[0] }, { page: list[index] });
}

const issues = [];
for (const page of pages) {
  const title = clean(page.title);
  const description = clean(page.description);
  const tags = [...(page.structureTags || []), ...(page.sceneTags || []), ...(page.tags || [])].filter(Boolean);
  const reasons = [];
  if (!title || /^\d+$/.test(title) || /^p\d+$/i.test(title)) reasons.push("标题疑似页码或为空");
  if (!description) reasons.push("缺少内容描述");
  if (!tags.length) reasons.push("缺少标签");
  if (description && title && description === title) reasons.push("描述与标题重复");
  if (!page.preview) reasons.push("缺少预览图");
  if (reasons.length) issues.push({ page: pageRef(page), reasons });
}

groups.sort((left, right) => right.score - left.score);
const report = {
  generatedAt: new Date().toISOString(),
  totalPages: pages.length,
  duplicateCandidateCount: groups.length,
  qualityIssueCount: issues.length,
  duplicateCandidates: groups,
  qualityIssues: issues,
};
const output = path.join(root, "data/quality-report.json");
await fs.writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.rename(`${output}.tmp`, output);
console.log(JSON.stringify({ totalPages: report.totalPages, duplicateCandidates: groups.length, qualityIssues: issues.length, output }));
