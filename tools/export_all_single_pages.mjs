#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactToolWorkspace, importArtifactTool } from "./presentation_runtime.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const workspace = path.join(root, ".tmp", "single-page-export");
const outDir = path.join(root, "output", "single-pages");
const dataPath = path.join(root, "data", "pages.json");

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}

async function main() {
  const pages = JSON.parse(await fs.readFile(dataPath, "utf8"));
  await ensureArtifactToolWorkspace(workspace);
  await fs.mkdir(outDir, { recursive: true });
  const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
  const groups = new Map();
  for (const page of pages) {
    if (!groups.has(page.sourceFile)) groups.set(page.sourceFile, []);
    groups.get(page.sourceFile).push(page);
  }
  for (const [sourceFile, deckPages] of groups) {
    for (const page of deckPages) {
      const presentation = await PresentationFile.importPptx(await FileBlob.load(path.join(root, "source_ppts", sourceFile)));
      const originals = slidesFromPresentation(presentation);
      const slide = originals[page.sourcePage - 1].duplicate();
      for (const original of originals) original.delete();
      slide.moveTo(0);
      const fileName = `${page.id}.pptx`;
      const outputPath = path.join(outDir, fileName);
      const single = await PresentationFile.exportPptx(presentation);
      await single.save(outputPath);
      page.download = `output/single-pages/${fileName}`;
    }
  }
  await fs.writeFile(dataPath, `${JSON.stringify(pages, null, 2)}\n`);
  await fs.writeFile(path.join(root, "data", "pages.js"), `window.REAL_PAGES = ${JSON.stringify(pages)};\n`);
  console.log(`exported ${pages.length} single-page files`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
