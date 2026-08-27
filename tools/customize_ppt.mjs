#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg } from "./presentation_runtime.mjs";
import { findTemplatePage, readTemplateContract, validateTemplateContent } from "./template_contract.mjs";

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}

function shapeText(shape) {
  try { return String(shape.text || ""); } catch { return ""; }
}

function replaceCustomerText(shape, sourceCustomer, targetCustomer) {
  const before = shapeText(shape);
  if (!before || !before.includes(sourceCustomer)) return null;
  const after = before.split(sourceCustomer).join(targetCustomer);
  try { shape.text = after; } catch { try { shape.text.replace(before, after); } catch {} }
  return shapeText(shape) === after ? { before, after } : { before, after: shapeText(shape), failed: true };
}

function inferPageRole(text, index, total) {
  const value = String(text || "");
  if (index === 1 || /封面|解决方案|汇报/.test(value) && index <= 2) return "cover";
  if (/目录|内容导航|议程/.test(value)) return "toc";
  if (index === total || /谢谢|感谢|Q&A|联系方式/.test(value)) return "closing";
  return "content";
}

function classifyPage(text, sourceCustomer, index, total) {
  const value = String(text || "");
  const hasSource = sourceCustomer && value.includes(sourceCustomer);
  const hasCustomerSpecific = /客户案例|客户数据|客户现状|组织架构|接口|专属|项目实施|现状与痛点|客户名称/.test(value);
  const role = inferPageRole(value, index, total);
  if (hasCustomerSpecific && inferPageRole(value, index, total) === "content") return { action: "pending", reason: "包含客户专属内容，需要目标客户资料确认" };
  if (hasSource) return { action: "rewrite", reason: "包含原客户名称或原客户上下文" };
  if (role === "cover" || role === "toc") return { action: "rewrite", reason: "客户化方案需要更新封面或目录" };
  return { action: "retain", reason: "通用产品、服务或方法内容，保留原页" };
}

function imageMetadata(image, slide) {
  return {
    slide,
    objectId: String(image.id || ""),
    objectName: String(image.toProto?.().name || "图片"),
    imageReference: String(image.imageReferenceId || ""),
    frame: image.frame || null,
  };
}

function imageContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shapeBox(shape) {
  try {
    const box = shape.position || shape.data?.position || {};
    return { left: Number(box.left) || 0, top: Number(box.top) || 0, width: Number(box.width) || 0, height: Number(box.height) || 0 };
  } catch { return { left: 0, top: 0, width: 0, height: 0 }; }
}

function replaceShapeText(shape, value) {
  const next = cleanText(value);
  try { shape.text = next; } catch { try { shape.text.replace(shapeText(shape), next); } catch {} }
  return shapeText(shape).trim() === next;
}

function clearShapeText(shape) {
  try { shape.text = ""; } catch { try { shape.text.replace(shapeText(shape), ""); } catch {} }
}

function tableCells(slide) {
  const cells = [];
  for (const table of slide.tables?.items || []) {
    const rows = Number(table.rowCount || table.rows?.length || 0);
    const columns = Number(table.columnCount || table.columns?.count || 0);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        try {
          const cell = table.getCell(row, column);
          if (cell) cells.push({ cell, table, row, column });
        } catch {}
      }
    }
  }
  return cells;
}

function tableText(slide) {
  return tableCells(slide).map(entry => String(entry.cell.value || entry.cell.text || "").trim()).filter(Boolean);
}

function replaceCustomerTableCell(entry, sourceCustomer, targetCustomer) {
  const { cell, table, row, column } = entry;
  const before = String(cell.value || cell.text || "");
  if (!before || !before.includes(sourceCustomer)) return null;
  const after = before.split(sourceCustomer).join(targetCustomer);
  try { table.setCellValue(row, column, after); } catch { try { cell.value = after; } catch { try { cell.text = after; } catch {} } }
  const finalText = String(table.getCell(row, column)?.value || table.getCell(row, column)?.text || "");
  return finalText === after ? { before, after } : { before, after: finalText, failed: true };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanText).filter(Boolean))];
}

function evidenceLines(gap, evidenceById, sourceCustomer) {
  const lines = [];
  for (const draft of Array.isArray(gap?.factDrafts) ? gap.factDrafts : []) {
    const evidence = evidenceById.get(String(draft.evidenceId));
    const text = cleanText(evidence?.text || draft.text);
    if (!text || (sourceCustomer && text.includes(sourceCustomer))) continue;
    for (const sentence of text.split(/[。！？；;.!?]+/).map(cleanText).filter(Boolean)) {
      if (sourceCustomer && sentence.includes(sourceCustomer)) continue;
      lines.push(sentence.slice(0, 220));
      if (lines.length >= 3) return uniqueStrings(lines);
    }
  }
  return uniqueStrings(lines);
}

function findGapTemplateSlide(slides, gap, changePlan) {
  const candidates = (Array.isArray(gap?.sourcePageNumbers) ? gap.sourcePageNumbers : [])
    .map(page => ({ page: Number(page), slide: slides[Number(page) - 1] }))
    .filter(item => item.slide && changePlan.find(plan => Number(plan.page) === item.page)?.action !== "remove");
  if (candidates.length) return candidates[0];
  const fallbackIndex = slides.findIndex((slide, index) => {
    const text = (slide.shapes?.items || []).map(shapeText).filter(Boolean).join(" ");
    return index > 1 && !/目录|谢谢|感谢|联系方式/.test(text);
  });
  return fallbackIndex >= 0 ? { page: fallbackIndex + 1, slide: slides[fallbackIndex] } : { page: 1, slide: slides[0] };
}

/**
 * Fill a duplicated source slide while preserving its editable objects.
 * Customer facts are copied only from evidence excerpts; no unsupported claim is created.
 */
function fillGapSlide({ slide, gap, targetCustomer, evidenceById, sourceCustomer, template }) {
  const shapes = slide.shapes?.items || [];
  const textItems = shapes.map((shape, index) => ({ shape, index, text: cleanText(shapeText(shape)), box: shapeBox(shape) })).filter(item => item.text);
  const sourceTitle = textItems.filter(item => item.box.top < 190).sort((a, b) => a.box.top - b.box.top || b.text.length - a.text.length)[0]?.shape;
  const title = `${targetCustomer}${cleanText(gap.title)}`;
  const body = evidenceLines(gap, evidenceById, sourceCustomer);
  const contractCheck = validateTemplateContent(template, { title, body });
  if (!contractCheck.ok) throw new Error(`缺口页 ${gap.id} 模板契约校验失败：${contractCheck.issues.join("；")}`);
  if (sourceTitle) replaceShapeText(sourceTitle, title);
  const titleId = sourceTitle?.id;
  const candidates = textItems
    .filter(item => item.shape.id !== titleId && item.text.length >= 18 && item.box.top > 45)
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  // Keep the template rhythm but remove stale source copy from the duplicated page.
  candidates.forEach((item, index) => index < body.length ? replaceShapeText(item.shape, body[index]) : clearShapeText(item.shape));
  if (!body.length && candidates[0]) replaceShapeText(candidates[0].shape, `${cleanText(gap.purpose)}（待销售补充）`);
  try {
    slide.speakerNotes.textFrame.setText(`客户化缺口页：${gap.id}\n证据：${(gap.evidenceIds || []).join(", ") || "无"}`);
  } catch {}
  return { title, body, sourcePage: null, evidenceIds: Array.isArray(gap.evidenceIds) ? gap.evidenceIds : [], templatePage: template?.pageId || null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const source = path.resolve(requireArg(args, "source"));
  const out = path.resolve(requireArg(args, "out"));
  const sourceCustomer = String(args["source-customer"] || "原客户").trim();
  const targetCustomer = requireArg(args, "target-customer");
  const targetLogo = typeof args["target-logo"] === "string" ? path.resolve(args["target-logo"]) : "";
  const changePlanPath = typeof args["change-plan"] === "string" ? path.resolve(args["change-plan"]) : "";
  if (sourceCustomer === targetCustomer) throw new Error("源客户和目标客户不能相同");
  if (targetLogo) await fs.stat(targetLogo);
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
  const slides = slidesFromPresentation(presentation);
  let confirmedPlan = null;
  if (changePlanPath) {
    confirmedPlan = JSON.parse(await fs.readFile(changePlanPath, "utf8"));
    if (!Array.isArray(confirmedPlan) || confirmedPlan.length !== slides.length) throw new Error("逐页变更计划与源 PPT 页数不一致");
  }
  // Imported decks often keep logos as image objects, outside the editable text layer.
  // Inspect the source before editing so a text-only replacement cannot be marked complete.
  const imageInventory = [];
  const replacements = [];
  const unsupportedCustomerRewrites = [];
  const residuals = [];
  const changePlan = [];
  let textShapeCount = 0;
  let imageCount = 0;
  const sourceBrandImages = [];
  const replacedBrandImages = [];
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const slide = slides[slideIndex];
    const slideTexts = [...(slide.shapes?.items || []).map(shapeText).filter(Boolean), ...tableText(slide)];
    const pageText = slideTexts.join("\n");
    const decision = confirmedPlan?.[slideIndex]
      ? { action: confirmedPlan[slideIndex].action, reason: String(confirmedPlan[slideIndex].reason || "销售已确认页面处理方式"), targetCustomerInputs: confirmedPlan[slideIndex].targetCustomerInputs || [] }
      : classifyPage(pageText, sourceCustomer, slideIndex + 1, slides.length);
    changePlan.push({ page: slideIndex + 1, title: slideTexts[0] || `第 ${slideIndex + 1} 页`, role: inferPageRole(pageText, slideIndex + 1, slides.length), ...decision, sourceCustomerMention: Boolean(sourceCustomer && pageText.includes(sourceCustomer)), replacements: [] });
    if (decision.action === "remove") {
      slide.delete();
      continue;
    }
    for (const shape of slide.shapes?.items || []) {
      const text = shapeText(shape);
      if (text) {
        textShapeCount += 1;
        const replacement = decision.action === "rewrite" ? replaceCustomerText(shape, sourceCustomer, targetCustomer) : null;
        if (replacement) {
          const item = { slide: slideIndex + 1, before: replacement.before, after: replacement.after, failed: Boolean(replacement.failed) };
          replacements.push(item);
          changePlan[changePlan.length - 1].replacements.push(item);
          if (decision.action === "rewrite" && sourceCustomer && replacement.before.length >= 24) unsupportedCustomerRewrites.push({ slide: slideIndex + 1, before: replacement.before.slice(0, 300), kind: "text" });
        }
        const finalText = shapeText(shape);
        if (finalText.includes(sourceCustomer)) residuals.push({ slide: slideIndex + 1, text: finalText.slice(0, 300), kind: "text" });
      }
    }
    for (const cell of tableCells(slide)) {
      const replacement = decision.action === "rewrite" ? replaceCustomerTableCell(cell, sourceCustomer, targetCustomer) : null;
      if (!replacement) continue;
      const item = { slide: slideIndex + 1, before: replacement.before, after: replacement.after, failed: Boolean(replacement.failed), kind: "table-cell" };
      replacements.push(item);
      changePlan[changePlan.length - 1].replacements.push(item);
      if (decision.action === "rewrite" && sourceCustomer && replacement.before.length >= 24) unsupportedCustomerRewrites.push({ slide: slideIndex + 1, before: replacement.before.slice(0, 300), kind: "table-cell" });
      if (String(replacement.after || "").includes(sourceCustomer)) residuals.push({ slide: slideIndex + 1, text: replacement.after.slice(0, 300), kind: "table-cell" });
    }
    // Logos are separate image elements and are not affected by text replacement.
    // The cover (and a same-named image reused elsewhere) is treated as brand
    // material; other photos and product illustrations are left untouched.
    for (const image of slide.images?.items || []) {
      imageCount += 1;
      const metadata = imageMetadata(image, slideIndex + 1);
      imageInventory.push(metadata);
      const sameReference = imageInventory.some(item => item !== metadata && item.imageReference && item.imageReference === metadata.imageReference && item.slide === 1);
      const frame = metadata.frame || {};
      const compactTopImage = Number(frame.width) > 0 && Number(frame.width) <= 300 && Number(frame.height) <= 150 && Number(frame.top) <= 190;
      const likelyBrand = (slideIndex === 0 && compactTopImage) || (sameReference && compactTopImage) || (metadata.objectName && /logo|品牌|客户/i.test(metadata.objectName));
      if (!likelyBrand) continue;
      sourceBrandImages.push(metadata);
      if (targetLogo) {
        const frame = image.frame;
        const crop = image.crop;
        const fit = image.fit;
        await image.replace({ blob: await fs.readFile(targetLogo), contentType: imageContentType(targetLogo), alt: `${targetCustomer} Logo`, fit: fit || "contain" });
        if (frame) image.frame = frame;
        if (crop) image.crop = crop;
        replacedBrandImages.push(metadata);
      } else {
        // Remove the source brand asset from the editable copy. Leaving it in
        // place would make a draft look like a completed target-customer deck.
        image.delete();
      }
    }
  }
  if (sourceBrandImages.length && !targetLogo) {
    const coverPlan = changePlan[0];
    if (coverPlan) {
      coverPlan.action = "pending";
      coverPlan.reason = "检测到原客户 Logo 图片，未提供目标客户 Logo，不能作为可交付方案";
      coverPlan.targetCustomerInputs = ["目标客户 Logo/品牌素材"];
    }
  }
  const pptx = await PresentationFile.exportPptx(presentation);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await pptx.save(out);
  const report = {
    source: path.basename(source),
    output: path.basename(out),
    sourceCustomer,
    targetCustomer,
    slideCount: changePlan.filter(item => item.action !== "remove").length,
    textShapeCount,
    imageCount,
    replacements,
    unsupportedCustomerRewrites,
    replacementCount: replacements.filter(item => !item.failed).length,
    failedReplacementCount: replacements.filter(item => item.failed).length,
    imageSlides: [...new Set(imageInventory.map(item => Number(item.slide)).filter(Number.isFinite))].sort((a, b) => a - b),
    sourceBrandImages,
    replacedBrandImages,
    brandAssetStatus: sourceBrandImages.length ? (targetLogo ? "replaced" : "missing-target-logo") : "not-detected",
    brandImageRiskPages: [...new Set(sourceBrandImages.map(item => item.slide))].sort((a, b) => a - b),
    residuals,
    needsReview: residuals.length > 0 || sourceBrandImages.length > replacedBrandImages.length || changePlan.some(item => item.action === "pending"),
    changePlan,
    evidence: [],
    missingCustomerInputs: ["目标客户行业背景", "客户现状与痛点", "客户案例或可引用数据", ...(sourceBrandImages.length && !targetLogo ? ["目标客户 Logo/品牌素材"] : [])],
  };
  await fs.writeFile(`${out}.customization.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const stat = await fs.stat(out);
  if (!stat.size) throw new Error(`空的导出文件：${out}`);
  console.log(JSON.stringify({ ...report, bytes: stat.size }));
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
