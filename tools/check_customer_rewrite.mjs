#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs, requireArg } from "./presentation_runtime.mjs";

const execFileAsync = promisify(execFile);
const VALID_ACTIONS = new Set(["retain", "rewrite", "pending", "remove", "create"]);
const ROLE_ALIASES = { contents: "toc", directory: "toc", end: "closing", cover_page: "cover", end_page: "closing" };

function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function textFromXml(xml) {
  const parts = String(xml || "").match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi) || [];
  return parts.map(item => decodeXml(item.replace(/^<a:t(?:\s[^>]*)?>|<\/a:t>$/gi, ""))).join(" ").replace(/\s+/g, " ").trim();
}
function normalizeText(value) { return decodeXml(String(value || "")).toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""); }
function displayText(value) { return decodeXml(String(value || "")).replace(/\s+/g, " ").trim(); }
function isPlaceholderTitle(value) {
  const title = displayText(value); const compact = title.replace(/[\s　]/g, "");
  if (!compact || compact === "待补充标题" || compact === "标题待补充") return true;
  return /^(?:第\s*)?\d+(?:页|页面|slide|page)?$/i.test(compact) || /^(?:slide|page)\s*\d+$/i.test(compact);
}
async function zipEntries(filePath) { const { stdout } = await execFileAsync("unzip", ["-Z1", filePath], { maxBuffer: 16 * 1024 * 1024 }); return String(stdout).split(/\r?\n/).filter(Boolean); }
async function readZipEntry(filePath, entry) { const { stdout } = await execFileAsync("unzip", ["-p", filePath, entry], { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }); return String(stdout || ""); }
async function inspectPptx(filePath) {
  const entries = await zipEntries(filePath);
  const names = entries.filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1]) - Number(b.match(/slide(\d+)\.xml/i)?.[1]));
  const slides = []; for (const name of names) slides.push({ xmlName: name, text: textFromXml(await readZipEntry(filePath, name)) });
  return { entries, slides };
}

async function inspectPptxTables(filePath) {
  const entries = await zipEntries(filePath);
  const names = entries.filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1]) - Number(b.match(/slide(\d+)\.xml/i)?.[1]));
  const slides = [];
  for (const name of names) {
    const xml = await readZipEntry(filePath, name);
    const tables = [...xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/gi)].map(match => textFromXml(match[0]));
    slides.push({ xmlName: name, tables });
  }
  return { slides };
}
function addIssue(issues, code, severity, message, details = {}) { issues.push({ code, severity, message, ...details }); }
function normalizeRole(role) { const value = displayText(role).toLowerCase(); return ROLE_ALIASES[value] || value; }

function planAndMapping(customization, sourceSlideCount, outputSlideCount) {
  const rawPlan = Array.isArray(customization.changePlan) ? customization.changePlan : [];
  const plan = rawPlan.map((item, index) => ({ ...item, page: item.action === "create" || (item.page == null && item.sourcePage == null) ? null : Number(item.page ?? item.sourcePage ?? index + 1), action: String(item.action || "").trim(), role: normalizeRole(item.role) }));
  const mapping = []; let outputPage = 0;
  for (const item of plan) { if (item.action !== "remove") outputPage += 1; mapping.push({ sourcePage: item.action === "create" ? null : item.page, outputPage: item.action === "remove" ? null : outputPage, pageId: item.pageId || item.id || null, action: item.action, role: item.role || "content", evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds : [] }); }
  const expectedOutputCount = plan.length ? plan.filter(item => item.action !== "remove").length : outputSlideCount;
  return { plan, mapping, expectedOutputCount };
}

function checkPlan(customization, sourceSlideCount, outputSlideCount, issues) {
  const { plan, mapping, expectedOutputCount } = planAndMapping(customization, sourceSlideCount, outputSlideCount);
  if (!plan.length) { addIssue(issues, "missing-change-plan", "review", "缺少逐页变更计划，无法核验页面角色和页级映射"); return { plan, mapping, expectedOutputCount, roleCompleteness: { hasCover: false, hasToc: false, hasClosing: false, validOrder: false } }; }
  const sourceItems = plan.filter(item => item.action !== "create");
  const pages = sourceItems.map(item => item.page).filter(page => page != null); const duplicates = pages.filter((page, index) => pages.indexOf(page) !== index);
  if (duplicates.length) addIssue(issues, "duplicate-plan-pages", "blocker", `变更计划包含重复页码：${[...new Set(duplicates)].join(", ")}`, { pages: [...new Set(duplicates)] });
  const expectedSourceCount = Number(sourceSlideCount || plan.length);
  const invalid = plan.filter(item => !VALID_ACTIONS.has(item.action) || (item.action !== "create" && (!Number.isInteger(item.page) || item.page < 1 || item.page > expectedSourceCount)) || (item.action === "create" && item.page != null));
  if (invalid.length) addIssue(issues, "invalid-plan-mapping", "blocker", `${invalid.length} 条变更计划的页码或动作无效`, { pages: invalid.map(item => item.page) });
  const missing = expectedSourceCount ? Array.from({ length: expectedSourceCount }, (_, index) => index + 1).filter(page => !pages.includes(page)) : [];
  if (missing.length) addIssue(issues, "incomplete-plan-mapping", "blocker", `变更计划缺少源页面：${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}`, { pages: missing });
  if (expectedOutputCount !== outputSlideCount) addIssue(issues, "plan-output-count-mismatch", "blocker", `计划预计输出 ${expectedOutputCount} 页，文件实际为 ${outputSlideCount} 页`, { expected: expectedOutputCount, actual: outputSlideCount });
  const preview = Array.isArray(customization.pagePreviews) ? customization.pagePreviews : [];
  if (preview.length) {
    const previewMap = preview.map(item => ({ sourcePage: item.sourcePage == null ? null : Number(item.sourcePage), outputPage: item.outputPage == null ? null : Number(item.outputPage), action: item.action }));
    const expected = mapping.map(item => ({ sourcePage: item.sourcePage, outputPage: item.outputPage, action: item.action }));
    if (JSON.stringify(previewMap) !== JSON.stringify(expected)) addIssue(issues, "preview-plan-mismatch", "review", "在线预览的页级映射与变更计划不一致");
  }
  const roles = plan.filter(item => item.action !== "remove").map(item => normalizeRole(item.role));
  const roleCompleteness = { hasCover: roles.includes("cover"), hasToc: roles.includes("toc"), hasClosing: roles.includes("closing"), validOrder: roles[0] === "cover" && roles.indexOf("toc") > roles.indexOf("cover") && roles.at(-1) === "closing" };
  if (!roleCompleteness.hasCover) addIssue(issues, "missing-cover", "review", "方案缺少封面页");
  if (!roleCompleteness.hasToc) addIssue(issues, "missing-toc", "review", "方案缺少目录页");
  if (!roleCompleteness.hasClosing) addIssue(issues, "missing-closing", "review", "方案缺少尾页");
  if (!roleCompleteness.validOrder) addIssue(issues, "invalid-role-order", "review", "封面、目录、尾页顺序不符合销售方案基本结构");
  return { plan, mapping, expectedOutputCount, roleCompleteness };
}

function checkContent(customization, outputSlides, sourceSlides, mapping, sourceCustomer, issues) {
  const evidence = Array.isArray(customization.evidence) ? customization.evidence : []; const evidenceIds = new Set(evidence.map(item => item?.id).filter(Boolean)); const claims = [];
  const collect = (value, pathName) => { if (!value || typeof value !== "object") return; for (const key of ["facts", "claims", "customerFacts", "verifiedClaims"]) if (Array.isArray(value[key])) value[key].forEach((claim, index) => claims.push({ claim, path: `${pathName}.${key}[${index}]` })); if (Array.isArray(value.evidenceIds)) value.evidenceIds.forEach((id, index) => claims.push({ claim: { evidenceId: id }, path: `${pathName}.evidenceIds[${index}]` })); };
  (customization.changePlan || []).forEach((item, index) => collect(item, `changePlan[${index}]`)); collect(customization, "customization");
  const noEvidence = claims.filter(({ claim }) => !claim || typeof claim !== "object" || !(claim.evidenceId || claim.evidenceIds || claim.sourceEvidenceId));
  const unknownEvidence = claims.filter(({ claim }) => { const ids = Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : [claim?.evidenceId || claim?.sourceEvidenceId]; return ids.filter(Boolean).some(id => !evidenceIds.has(id)); });
  if (claims.length && noEvidence.length) addIssue(issues, "facts-without-evidence", "blocker", `${noEvidence.length} 条客户事实缺少 evidenceId 追溯`, { paths: noEvidence.map(item => item.path) });
  if (unknownEvidence.length) addIssue(issues, "unknown-evidence-id", "blocker", `${unknownEvidence.length} 条事实引用了不存在的 evidenceId`, { paths: unknownEvidence.map(item => item.path) });
  if (sourceCustomer) {
    for (const item of customization.changePlan || []) {
      if (item.action !== "rewrite" || !item.sourceCustomerMention || (Array.isArray(item.evidenceIds) && item.evidenceIds.length)) continue;
      const longReplacements = (Array.isArray(item.replacements) ? item.replacements : [])
        .filter(replacement => String(replacement?.before || "").includes(sourceCustomer) && String(replacement?.before || "").trim().length >= 24);
      if (longReplacements.length) {
        addIssue(issues, "unsupported-customer-rewrite", "blocker", `第 ${item.page} 页将源客户长段事实直接改名为目标客户，但没有逐页证据`, { page: item.page, replacementCount: longReplacements.length });
      }
    }
  }
  const titles = [];
  for (const item of customization.changePlan || []) { const title = displayText(item.title); if (item.action !== "remove" && isPlaceholderTitle(title)) addIssue(issues, "placeholder-title", "review", `第 ${item.page} 页标题为空或仍是页码占位`, { page: item.page }); const body = displayText(item.description || item.summary || item.body || item.contentDescription || ""); if (body && normalizeText(body) === normalizeText(title)) addIssue(issues, "title-body-duplicate", "review", `第 ${item.page} 页标题与正文描述完全重复`, { page: item.page }); if (title) titles.push({ title, page: item.page }); }
  for (let index = 1; index < titles.length; index += 1) if (normalizeText(titles[index].title) === normalizeText(titles[index - 1].title)) addIssue(issues, "adjacent-duplicate-title", "review", `第 ${titles[index - 1].page} 页与第 ${titles[index].page} 页标题重复`, { pages: [titles[index - 1].page, titles[index].page] });
  if (sourceCustomer) outputSlides.forEach((slide, index) => { if (slide.text.includes(sourceCustomer)) addIssue(issues, "source-customer-residual", "blocker", `输出第 ${index + 1} 页仍包含源客户名称“${sourceCustomer}”`, { outputPage: index + 1 }); });
  const oldCopy = (Array.isArray(customization.replacements) ? customization.replacements : [])
    .map(item => displayText(item.before)).filter(value => value.length >= 4);
  for (const before of oldCopy) {
    const outputPage = outputSlides.findIndex(slide => normalizeText(slide.text).includes(normalizeText(before)));
    if (outputPage >= 0) addIssue(issues, "old-copy-residual", "blocker", `输出第 ${outputPage + 1} 页仍包含已替换前的旧文案`, { outputPage: outputPage + 1, text: before.slice(0, 160) });
  }
  if (sourceSlides.length && mapping.length) for (const item of mapping) {
    if (item.action !== "retain" || !item.outputPage) continue;
    const source = sourceSlides[item.sourcePage - 1]?.text;
    const output = outputSlides[item.outputPage - 1]?.text;
    const comparableOutput = output == null ? output : String(output).split("\n__TABLES__")[0];
    if (source != null && comparableOutput != null && normalizeText(source) !== normalizeText(comparableOutput)) addIssue(issues, "non-target-page-modified", "blocker", `源第 ${item.sourcePage} 页标记为保留，但输出第 ${item.outputPage} 页文字已变化`, { sourcePage: item.sourcePage, outputPage: item.outputPage });
  }
}

export async function checkCustomerRewrite({ pptx, customization, sourcePptx = "", sourceCustomer = "" }) {
  const issues = []; let outputInfo;
  try { outputInfo = await inspectPptx(pptx); } catch (error) { addIssue(issues, "invalid-pptx", "blocker", `无法读取 PPTX：${error.message}`); return { pptx: path.basename(pptx), status: "failed", deliverable: false, issues }; }
  let zipIntegrity = true; try { await execFileAsync("unzip", ["-t", pptx], { maxBuffer: 8 * 1024 * 1024 }); } catch { zipIntegrity = false; }
  if (!zipIntegrity) addIssue(issues, "invalid-zip", "blocker", "PPTX 压缩包完整性检查失败"); if (!outputInfo.slides.length) addIssue(issues, "invalid-pptx", "blocker", "PPTX 中没有幻灯片页面");
  const sourceInfo = sourcePptx ? await inspectPptx(sourcePptx).catch(() => ({ slides: [] })) : { slides: [] }; const outputTables = await inspectPptxTables(pptx).catch(() => ({ slides: [] })); const sourceSlideCount = sourceInfo.slides.length || Number(customization.sourceSlideCount || customization.changePlan?.length || 0); const outputSlideCount = outputInfo.slides.length;
  if (customization.slideCount != null && Number(customization.slideCount) !== outputSlideCount) addIssue(issues, "slide-count-mismatch", "blocker", `报告为 ${customization.slideCount} 页，文件为 ${outputSlideCount} 页`);
  if (customization.failedReplacementCount) addIssue(issues, "text-replacement-failed", "blocker", `${customization.failedReplacementCount} 处客户名称替换失败`); if (customization.residuals?.length) addIssue(issues, "source-text-residual", "blocker", `仍有 ${customization.residuals.length} 处源客户文字残留`); if (customization.sourceBrandImages?.length && customization.brandAssetStatus !== "replaced") addIssue(issues, "target-logo-required", "review", `已移除 ${customization.sourceBrandImages.length} 个疑似源客户品牌图片；需要上传目标客户 Logo`);
  const planReport = checkPlan(customization, sourceSlideCount, outputSlideCount, issues); checkContent(customization, outputInfo.slides.map((slide, index) => ({ ...slide, text: `${slide.text}\n__TABLES__\n${(outputTables.slides[index]?.tables || []).join("\n")}` })), sourceInfo.slides, planReport.mapping, sourceCustomer || customization.sourceCustomer, issues);
  let editableShapeCount = 0; for (const slide of outputInfo.slides) if (/<p:sp[ >][\s\S]*?<a:t[ >]/i.test(await readZipEntry(pptx, slide.xmlName))) editableShapeCount += 1; if (!editableShapeCount) addIssue(issues, "not-editable", "blocker", "导出文件没有可编辑文本对象");
  const blockers = issues.filter(item => item.severity === "blocker"); const reviews = issues.filter(item => item.severity === "review");
  return { checkedAt: new Date().toISOString(), pptx: path.basename(pptx), sourceCustomer: sourceCustomer || customization.sourceCustomer || "", targetCustomer: customization.targetCustomer, slideCount: outputSlideCount, sourceSlideCount, zipIntegrity, editablePptx: editableShapeCount > 0, editableShapeCount, sourceTextResidualCount: issues.filter(item => ["source-text-residual", "source-customer-residual"].includes(item.code)).length, sourceBrandImageCount: customization.sourceBrandImages?.length || 0, replacedBrandImageCount: customization.replacedBrandImages?.length || 0, placeholderPageCount: issues.filter(item => item.code === "placeholder-title").length, planMapping: planReport.mapping, roleCompleteness: planReport.roleCompleteness, expectedOutputCount: planReport.expectedOutputCount, issueCounts: { blocker: blockers.length, review: reviews.length, total: issues.length }, status: blockers.length ? "failed" : reviews.length ? "needs-review" : "passed", deliverable: !blockers.length && !reviews.length, issues };
}

async function main() { const args = parseArgs(process.argv.slice(2)); const pptx = path.resolve(requireArg(args, "pptx")); const customization = JSON.parse(await fs.readFile(`${pptx}.customization.json`, "utf8")); const sourcePptx = typeof args.source === "string" ? path.resolve(args.source) : ""; const report = await checkCustomerRewrite({ pptx, customization, sourcePptx, sourceCustomer: String(args["source-customer"] || customization.sourceCustomer || "").trim() }); await fs.writeFile(`${pptx}.quality.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.log(JSON.stringify(report)); if (report.status === "failed" && args["allow-fail"] !== true && args["allow-fail"] !== "true") process.exitCode = 2; }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
