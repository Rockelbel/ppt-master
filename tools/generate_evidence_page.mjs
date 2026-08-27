#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { findTemplatePage, readTemplateContract, validateTemplateContent } from "./template_contract.mjs";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg, saveBlobToFile } from "./presentation_runtime.mjs";

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}
function textOf(shape) { try { return String(shape.text || "").trim(); } catch { return ""; } }
function boxOf(shape) { const box = shape.position || shape.data?.position || {}; return { top: Number(box.top) || 0, left: Number(box.left) || 0 }; }
function setText(shape, value) {
  const before = textOf(shape);
  try { shape.text = value; } catch { try { shape.text.replace(before, value); } catch {} }
  return textOf(shape) === String(value).trim();
}
function clearText(shape) { try { shape.text = ""; } catch { try { shape.text.replace(textOf(shape), ""); } catch {} } }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const source = path.resolve(requireArg(args, "source"));
  const page = Number.parseInt(requireArg(args, "page"), 10);
  const content = JSON.parse(await fs.readFile(path.resolve(requireArg(args, "content")), "utf8"));
  const output = path.resolve(requireArg(args, "out"));
  const preview = path.resolve(requireArg(args, "preview"));
  const contract = await readTemplateContract(path.resolve(requireArg(args, "contract")));
  const template = findTemplatePage(contract, { pageId: content.pageId, sourceFile: source, sourcePage: page });
  if (!template) throw new Error("模板契约中找不到缺口页模板");
  const validation = validateTemplateContent(template, { title: content.title, body: content.body });
  if (!validation.ok) throw new Error(`模板契约校验失败：${validation.issues.join("；")}`);
  if (!Array.isArray(template.body) || template.body.length < Math.min(3, content.body.length)) throw new Error("缺口页模板正文槽不足");
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
  const originals = slidesFromPresentation(presentation);
  const selected = originals[page - 1]?.duplicate();
  if (!selected) throw new Error(`源模板第 ${page} 页不存在`);
  for (const slide of originals) if (slide !== selected) slide.delete();
  const shapes = selected.shapes?.items || [];
  const titleSlot = template.textSlots.find(slot => slot.slotId === template.editableConstraints.titleSlotId);
  const titleShape = shapes[Number(titleSlot?.objectRef?.index)];
  if (!titleShape || !setText(titleShape, content.title)) throw new Error("标题槽写入失败");
  const values = (content.body || []).map(value => String(value || "").trim()).filter(Boolean).slice(0, 3);
  const bodySlots = template.textSlots.filter(slot => slot.kind === "body");
  bodySlots.forEach((slot, index) => {
    const shape = shapes[Number(slot.objectRef?.index)];
    if (!shape) return;
    if (index < values.length) setText(shape, values[index]); else clearText(shape);
  });
  const stale = shapes.map(textOf).filter(text => text.length >= 14 && ![content.title, ...values].includes(text) && template.textSlots.some(slot => slot.kind === "body" && slot.originalText === text));
  if (stale.length) throw new Error(`仍有未清理的模板旧文案：${stale.slice(0, 2).join("；")}`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(path.dirname(preview), { recursive: true });
  await (await PresentationFile.exportPptx(presentation)).save(output);
  await saveBlobToFile(await presentation.export({ slide: selected, format: "png", scale: 2 }), preview);
  const textShapes = shapes.map(shape => ({ text: textOf(shape), ...boxOf(shape) })).filter(item => item.text);
  process.stdout.write(`${JSON.stringify({ output, preview, pageId: template.pageId, textShapes })}\n`);
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
