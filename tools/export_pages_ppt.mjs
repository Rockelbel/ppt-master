#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg } from "./presentation_runtime.mjs";

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}

async function exportEditableDeck({ pages, root, workspace, FileBlob, Presentation, PresentationFile, output }) {
  const sources = new Map();
  for (const page of pages) {
    const sourceKey = page.generatedPptx || page.sourceFile;
    if (!sources.has(sourceKey)) {
      const sourcePath = page.generatedPptx ? path.join(root, page.generatedPptx) : path.join(root, "source_ppts", page.sourceFile);
      const imported = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
      sources.set(sourceKey, imported.toProto());
    }
  }
  const firstProto = structuredClone(sources.values().next().value);
  const selectedSlides = [];
  const imageIds = new Map();
  const sourceImageMaps = new Map();
  let sourceIndex = 0;
  for (const [sourceFile, sourceProto] of sources) {
    const imageMap = new Map();
    for (const image of sourceProto.images || []) {
      const oldId = image.id;
      const newId = `/ppt/media/merge-${sourceIndex}-${path.basename(oldId)}`;
      imageMap.set(oldId, newId);
      const mergedImage = structuredClone(image);
      mergedImage.id = newId;
      imageIds.set(newId, mergedImage);
    }
    sourceImageMaps.set(sourceFile, imageMap);
    sourceIndex += 1;
  }
  for (const page of pages) {
    const sourceKey = page.generatedPptx || page.sourceFile;
    const sourceProto = sources.get(sourceKey);
    const sourceSlide = sourceProto.slides[page.generatedPptx ? 0 : page.sourcePage - 1];
    if (!sourceSlide) throw new Error(`${page.sourceFile || page.generatedPptx} 第 ${page.sourcePage || 1} 页不存在`);
    const slide = structuredClone(sourceSlide);
    slide.id = `merge-slide-${selectedSlides.length}`;
    slide.index = selectedSlides.length;
    rewriteImageReferences(slide, sourceImageMaps.get(sourceKey));
    selectedSlides.push(slide);
  }
  firstProto.slides = selectedSlides;
  firstProto.images = [...imageIds.values()];
  const presentation = Presentation.load(firstProto);
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(output);
}

function rewriteImageReferences(value, imageMap) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key === "imageReference") && typeof child === "string" && imageMap.has(child)) value[key] = imageMap.get(child);
    else if (key === "imageReference" && child && typeof child.id === "string" && imageMap.has(child.id)) child.id = imageMap.get(child.id);
    else rewriteImageReferences(child, imageMap);
  }
}

async function exportImageDeck({ pages, root, Presentation, PresentationFile, output }) {
  const presentation = Presentation.create({ slideSize: { width: 960, height: 540 } });
  for (const page of pages) {
    const slide = presentation.slides.add();
    const previewPath = path.join(root, page.preview);
    const bytes = await fs.readFile(previewPath);
    slide.images.add({
      blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      contentType: "image/png",
      alt: page.title || "页面预览",
      fit: "fill",
      position: { left: 0, top: 0, width: 960, height: 540 },
    });
  }
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const workspace = path.resolve(requireArg(args, "workspace"));
  const ids = requireArg(args, "ids").split(",").map(id => id.trim()).filter(Boolean);
  const output = path.resolve(requireArg(args, "out"));
  if (!ids.length) throw new Error("至少选择一个页面");
  const allPages = [
    ...JSON.parse(await fs.readFile(path.join(root, "data", "pages.json"), "utf8")),
    ...(await fs.readFile(path.join(root, ".tmp", "ai-generated-pages.json"), "utf8").then(JSON.parse).catch(() => [])),
  ];
  const byId = new Map(allPages.map(page => [page.id, page]));
  const pages = ids.map(id => byId.get(id)).filter(Boolean);
  if (pages.length !== ids.length) throw new Error("有页面已不存在，请刷新页面后重试");
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, Presentation, PresentationFile } = await importArtifactTool(workspace);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await exportEditableDeck({ pages, root, workspace, FileBlob, Presentation, PresentationFile, output });
  const stat = await fs.stat(output);
  if (!stat.size) throw new Error(`空的导出文件: ${output}`);
  console.log(JSON.stringify({ pages: pages.length, mode: "editable-merged", sources: new Set(pages.map(page => page.sourceFile)).size, output, bytes: stat.size }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
