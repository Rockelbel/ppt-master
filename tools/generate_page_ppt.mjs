#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { findTemplatePage, readTemplateContract, validateTemplateContent } from "./template_contract.mjs";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg, saveBlobToFile } from "./presentation_runtime.mjs";

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}

function shapeText(shape) {
  try { return String(shape.text || "").trim(); } catch { return ""; }
}

function shapeBox(shape) {
  try {
    const box = shape.position || shape.data?.position || {};
    return { left: Number(box.left) || 0, top: Number(box.top) || 0, width: Number(box.width) || 0, height: Number(box.height) || 0 };
  } catch { return { left: 0, top: 0, width: 0, height: 0 }; }
}

function uniqueLines(values) {
  return [...new Set(values.map(value => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function replaceText(shape, value) {
  const before = shapeText(shape);
  if (!before || value === undefined || value === null) return false;
  try { shape.text = value; } catch { try { shape.text.replace(before, value); } catch {} }
  if (shapeText(shape) !== String(value).trim()) {
    try { shape.text = value; } catch {}
  }
  return shapeText(shape) === String(value).trim();
}

function clearText(shape) {
  try { shape.text = ""; } catch { try { shape.text.replace(shapeText(shape), ""); } catch {} }
}

function setShapeTextBySource(slide, sourceText, value) {
  const shape = (slide.shapes?.items || []).find(item => shapeText(item) === sourceText);
  if (!shape) throw new Error(`模板内容槽不存在：${sourceText}`);
  if (value) replaceText(shape, value);
  else clearText(shape);
  return shape;
}

function applyTravelControlIntegration(slide, content) {
  const body = uniqueLines(content.body || []);
  if (body.length < 3) throw new Error("商旅管控整合页需要 3 个内容要点");
  setShapeTextBySource(slide, "通过自然语言理解和智能决策，覆盖行程规划、预订、服务和报销材料整理全流程，让个人工作出行更简单、更高效、更省心。", content.subtitle);
  setShapeTextBySource(slide, "为什么需要", "商旅服务");
  setShapeTextBySource(slide, "服务对象", "管控能力");
  setShapeTextBySource(slide, "产品定位", "一体化定位");
  setShapeTextBySource(slide, "核心场景", "一体化流程");
  setShapeTextBySource(slide, "核心价值", "客户价值");
  setShapeTextBySource(slide, "企业差旅系统无法覆盖全部工作出行", body[0]);
  setShapeTextBySource(slide, "小微企业员工", body[1]);
  setShapeTextBySource(slide, "以个人身份和个人支付为基础，围绕一次完整工作出行，连续承接规划、预订、服务和报销材料整理。", body[2]);
  for (const text of [
    "规划、预订、服务和报销分散在不同平台", "工作出行更强调效率、确定性和时效",
    "独立顾问及自由职业者", "未被系统覆盖的专业服务人员",
    "不涉及企业审批、差标、预算及企业支付",
  ]) setShapeTextBySource(slide, text, "");
  for (const bullet of (slide.shapes?.items || []).filter(item => shapeText(item) === "•")) clearText(bullet);
  for (const [from, to] of [
    ["临时出差", "事前预算与申请"], ["多段/复杂行程", "事中预订与消费"],
    ["强时间约束", "行中服务与变更"], ["行程临时变化", "事后对账与报销"],
    ["个人支付与报销准备", "数据分析与优化"],
  ]) setShapeTextBySource(slide, from, to);
  setShapeTextBySource(slide, "不是单一的预订工具，而是连续承接个人工作出行规划、交易、服务及报销准备的智能商旅助手。", content.subtitle);
}

function assertNoStaleLongCopy(slide, sourceTexts, generatedValues) {
  const finalTexts = new Set((slide.shapes?.items || []).map(shapeText).filter(Boolean));
  const generated = new Set(generatedValues.map(value => String(value || "").trim()).filter(Boolean));
  const stale = sourceTexts.filter(text => text.length >= 14 && finalTexts.has(text) && !generated.has(text));
  if (stale.length) throw new Error(`模板仍有未替换的旧文案：${stale.slice(0, 2).join("；")}`);
}

function clearUnusedTemplateCopy(slide, sourceTexts, generatedValues) {
  const generated = new Set(generatedValues.map(value => String(value || "").trim()).filter(Boolean));
  const stale = new Set(sourceTexts.filter(text => text.length >= 14 && !generated.has(text)));
  for (const shape of slide.shapes?.items || []) {
    if (stale.has(shapeText(shape))) clearText(shape);
  }
}

function findTitleShape(slide, content, sourceTitle) {
  const title = String(sourceTitle || "").trim();
  const shapes = slide.shapes?.items || [];
  return shapes.find(shape => shapeText(shape) === title)
    || shapes.find(shape => { const text = shapeText(shape); return text && (text.includes(title) || title.includes(text)); })
    || shapes.map(shape => ({ shape, box: shapeBox(shape), text: shapeText(shape) }))
      .filter(item => item.text && item.box.top < 70)
      .sort((a, b) => a.box.top - b.box.top || b.text.length - a.text.length)[0]?.shape;
}

function findBodyShapes(slide, titleShape, content) {
  const titleId = titleShape?.id;
  const all = (slide.shapes?.items || [])
    .map(shape => ({ shape, text: shapeText(shape), box: shapeBox(shape) }))
    .filter(item => item.text && item.shape.id !== titleId && item.box.top > 45);
  const bodyRegion = content?.bodyRegion;
  let shapes = all.filter(item => item.text.length >= 18);
  if (bodyRegion === "center" && all.length) {
    const right = Math.max(...all.map(item => item.box.left + item.box.width), 1280);
    const center = right / 2;
    const centered = all.filter(item => Math.abs(item.box.left + item.box.width / 2 - center) < right * 0.24 && item.box.top > 160);
    if (centered.length) shapes = centered;
  }
  shapes = shapes.sort((a, b) => bodyRegion === "center" ? a.box.top - b.box.top || a.box.left - b.box.left : b.text.length - a.text.length || a.box.top - b.box.top);
  const requested = Array.isArray(content.body) ? content.body : [];
  const count = Math.min(Math.max(requested.length, 1), 3);
  return shapes.slice(0, count).sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left).map(item => item.shape);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const source = path.resolve(requireArg(args, "source"));
  const page = Number.parseInt(requireArg(args, "page"), 10);
  const contentPath = path.resolve(requireArg(args, "content"));
  const out = path.resolve(requireArg(args, "out"));
  const preview = path.resolve(requireArg(args, "preview"));
  if (!Number.isInteger(page) || page < 1) throw new Error("--page must be a positive integer");
  const content = JSON.parse(await fs.readFile(contentPath, "utf8"));
  const contract = typeof args.contract === "string" ? await readTemplateContract(path.resolve(args.contract)) : null;
  const template = contract ? findTemplatePage(contract, { pageId: content.pageId, sourceFile: source, sourcePage: page }) : null;
  const contractValidation = validateTemplateContent(template, { title: content.title, body: content.body || [content.subtitle] });
  if (!contractValidation.ok) throw new Error(`模板契约校验失败：${contractValidation.issues.join("；")}`);
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
  const originals = slidesFromPresentation(presentation);
  if (page > originals.length) throw new Error(`Page ${page} exceeds deck length ${originals.length}`);
  const sourceSlide = originals[page - 1];
  const sourceTexts = uniqueLines((sourceSlide.shapes?.items || []).map(shapeText));
  const sourceTitle = shapeText((sourceSlide.shapes?.items || []).find(shape => shape.placeholder === "title"))
    || shapeText((sourceSlide.shapes?.items || []).map(shape => ({ shape, text: shapeText(shape), box: shapeBox(shape) }))
      .filter(item => item.text && item.box.top < 180)
      .sort((a, b) => a.box.top - b.box.top || b.text.length - a.text.length)[0]?.shape);
  const selected = sourceSlide.duplicate();
  for (const slideItem of slidesFromPresentation(presentation)) if (slideItem !== selected) slideItem.delete();
  const titleShape = findTitleShape(selected, content, sourceTitle);
  if (!titleShape) throw new Error("模板页没有找到可编辑标题文本框");
  const generatedTitle = String(content.title || "新建页面");
  if (!replaceText(titleShape, generatedTitle)) titleShape.text = generatedTitle;
  for (const shape of selected.shapes?.items || []) {
    if (shape.id !== titleShape.id && shapeText(shape) === sourceTitle) replaceText(shape, generatedTitle);
  }
  const bodyValues = uniqueLines(Array.isArray(content.body) ? content.body : [content.subtitle]).slice(0, 3);
  let bodyShapes = [];
  if (content.layoutProfile === "travel-control-integration") {
    applyTravelControlIntegration(selected, content);
  } else {
    bodyShapes = findBodyShapes(selected, titleShape, content);
    if (bodyValues.length && !bodyShapes.length) throw new Error("模板页没有找到可编辑正文文本框");
    if (bodyShapes.length === 1) replaceText(bodyShapes[0], bodyValues.join("\n"));
    else bodyShapes.forEach((shape, index) => replaceText(shape, bodyValues[index] || ""));
  }
  clearUnusedTemplateCopy(selected, sourceTexts, [generatedTitle, content.subtitle, ...bodyValues]);
  assertNoStaleLongCopy(selected, sourceTexts, [generatedTitle, content.subtitle, ...bodyValues]);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(path.dirname(preview), { recursive: true });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
  await saveBlobToFile(await presentation.export({ slide: selected, format: "png", scale: 2 }), preview);
  const inspect = await presentation.inspect({ target: { id: selected.id }, kind: "slide,textbox,shape,image", max_chars: 20000 });
  await fs.writeFile(`${out}.inspect.ndjson`, inspect.ndjson || "", "utf8");
  const stat = await fs.stat(out);
  if (!stat.size) throw new Error(`Empty output: ${out}`);
  console.log(JSON.stringify({ out, preview, bytes: stat.size, sourcePage: page, pageId: template?.pageId || content.pageId || null, templateContractVersion: contract?.version || null, title: content.title, editedBodyCount: bodyShapes.length }));
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
