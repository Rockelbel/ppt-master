#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg } from "./presentation_runtime.mjs";

function slidesFromProto(presentation) {
  return Array.isArray(presentation?.slides) ? presentation.slides : [];
}

function rewriteImageReferences(value, imageMap) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key === "imageReference") && typeof child === "string" && imageMap.has(child)) {
      value[key] = imageMap.get(child);
    } else if (key === "imageReference" && child && typeof child.id === "string" && imageMap.has(child.id)) {
      child.id = imageMap.get(child.id);
    } else {
      rewriteImageReferences(child, imageMap);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const manifestPath = path.resolve(requireArg(args, "manifest"));
  const output = path.resolve(requireArg(args, "out"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest?.sources) || !Array.isArray(manifest?.slides) || !manifest.slides.length) {
    throw new Error("合并清单必须包含 sources 和 slides");
  }
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, Presentation, PresentationFile } = await importArtifactTool(workspace);
  const sourceProtos = new Map();
  for (const item of manifest.sources) {
    if (!item?.key || !item?.path) throw new Error("合并清单存在无效来源");
    const sourcePath = path.resolve(item.path);
    const imported = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
    sourceProtos.set(item.key, imported.toProto());
  }
  const imageIds = new Map();
  const imageMaps = new Map();
  let sourceIndex = 0;
  for (const [key, proto] of sourceProtos) {
    const imageMap = new Map();
    for (const image of proto.images || []) {
      const oldId = image.id;
      const newId = `/ppt/media/merge-${sourceIndex}-${path.basename(oldId)}`;
      imageMap.set(oldId, newId);
      const merged = structuredClone(image);
      merged.id = newId;
      imageIds.set(newId, merged);
    }
    imageMaps.set(key, imageMap);
    sourceIndex += 1;
  }
  const first = structuredClone(sourceProtos.values().next().value);
  const selectedSlides = [];
  for (const item of manifest.slides) {
    const proto = sourceProtos.get(item.sourceKey);
    if (!proto) throw new Error(`找不到来源：${item.sourceKey}`);
    const sourceSlide = slidesFromProto(proto)[Number(item.sourcePage) - 1];
    if (!sourceSlide) throw new Error(`${item.sourceKey} 第 ${item.sourcePage} 页不存在`);
    const slide = structuredClone(sourceSlide);
    slide.id = `merge-slide-${selectedSlides.length}`;
    slide.index = selectedSlides.length;
    rewriteImageReferences(slide, imageMaps.get(item.sourceKey));
    selectedSlides.push(slide);
  }
  first.slides = selectedSlides;
  first.images = [...imageIds.values()];
  const presentation = Presentation.load(first);
  const pptx = await PresentationFile.exportPptx(presentation);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await pptx.save(output);
  const stat = await fs.stat(output);
  if (!stat.size) throw new Error("合并输出为空");
  process.stdout.write(`${JSON.stringify({ output, pages: selectedSlides.length, sources: sourceProtos.size, bytes: stat.size })}\n`);
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
