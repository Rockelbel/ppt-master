#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureArtifactToolWorkspace,
  importArtifactTool,
  parseArgs,
  requireArg,
  saveBlobToFile,
} from "./presentation_runtime.mjs";

const args = parseArgs(process.argv.slice(2));
const workspace = path.resolve(requireArg(args, "workspace"));
const pptxPath = path.resolve(requireArg(args, "pptx"));
const outDir = path.resolve(requireArg(args, "out-dir"));
const scale = Number(args.scale || 2);
await ensureArtifactToolWorkspace(workspace);
const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
const slides = presentation.slides.items || [];
const slidesDir = path.join(outDir, "source-slides");
await fs.mkdir(slidesDir, { recursive: true });
const slideArtifacts = [];
for (let index = 0; index < slides.length; index += 1) {
  const slide = slides[index];
  const slideNumber = index + 1;
  const target = path.join(slidesDir, `source-slide-${String(slideNumber).padStart(2, "0")}.png`);
  try {
    const preview = await presentation.export({ slide, format: "png", scale });
    await saveBlobToFile(preview, target);
    slideArtifacts.push({ slide: slideNumber, previewPath: target });
  } catch (error) {
    console.error(`slide ${slideNumber} failed: ${error.message}`);
  }
}
await fs.writeFile(path.join(outDir, "template-manifest.json"), `${JSON.stringify({ sourcePptx: pptxPath, slideArtifacts }, null, 2)}\n`);
console.log(JSON.stringify({ slideCount: slides.length, slideArtifacts }));
