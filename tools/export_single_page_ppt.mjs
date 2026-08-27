#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureArtifactToolWorkspace, importArtifactTool, parseArgs, requireArg } from "./presentation_runtime.mjs";

function slidesFromPresentation(presentation) {
  if (Array.isArray(presentation.slides?.items)) return presentation.slides.items;
  return Array.from({ length: presentation.slides.count }, (_, index) => presentation.slides.getItem(index));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const source = path.resolve(requireArg(args, "source"));
  const page = Number.parseInt(requireArg(args, "page"), 10);
  const out = path.resolve(requireArg(args, "out"));
  if (!Number.isInteger(page) || page < 1) throw new Error("--page must be a positive integer");
  await ensureArtifactToolWorkspace(workspace);
  const { FileBlob, PresentationFile } = await importArtifactTool(workspace);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
  const originals = slidesFromPresentation(presentation);
  if (page > originals.length) throw new Error(`Page ${page} exceeds deck length ${originals.length}`);
  const selected = originals[page - 1].duplicate();
  for (const slide of originals) slide.delete();
  selected.moveTo(0);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
  const stat = await fs.stat(out);
  if (!stat.size) throw new Error(`Empty output: ${out}`);
  console.log(JSON.stringify({ source, page, out, bytes: stat.size }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
