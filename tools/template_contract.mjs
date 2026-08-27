#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const VERSION = "template-contract-v1";

function clean(value) {
  return String(value || "").replace(/[\s　]+/g, " ").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function pageRole(page) {
  return String(page.pageRole || (page.structureTags || [])[0] || "content");
}

function sourcePageKey(sourceFile, sourcePage) {
  return `${clean(sourceFile)}#${Number(sourcePage)}`;
}

function slotCapacity(text, kind) {
  const length = clean(text).length;
  const floor = kind === "title" ? 40 : kind === "page-marker" ? 12 : 80;
  const hardCeiling = kind === "title" ? 180 : kind === "page-marker" ? 16 : 1200;
  return {
    originalChars: length,
    recommendedMaxChars: Math.min(hardCeiling, Math.max(floor, Math.ceil(Math.max(length, 1) * 1.25))),
    hardMaxChars: hardCeiling,
  };
}

function slotFor(block, index, title) {
  const text = clean(block?.text);
  const placeholder = String(block?.placeholder || "");
  const isMarker = placeholder === "sldNum" || /^\d{1,4}$/.test(text);
  const isTitle = !isMarker && (text === clean(title) || placeholder === "title" || placeholder === "ctrTitle");
  const kind = isTitle ? "title" : isMarker ? "page-marker" : "body";
  const slotId = `${kind}-${index + 1}`;
  const capacity = slotCapacity(text, kind);
  return {
    slotId,
    kind,
    objectRef: { type: "text", index, placeholder: placeholder || null },
    originalText: text,
    originalTextFingerprint: `sha256:${sha256(text)}`,
    capacity,
    editable: kind !== "page-marker",
    mustPreserveObject: true,
    replacementPolicy: kind === "title" ? "replace-in-place" : kind === "body" ? "replace-in-place-or-clear" : "preserve",
  };
}

function normalizeSourceMetadata(sourceMetadata) {
  const entries = sourceMetadata && !Array.isArray(sourceMetadata) ? Object.entries(sourceMetadata) : [];
  return entries.flatMap(([deckId, deck]) => (deck.pages || []).map(page => ({ ...page, deckId, sourceFile: page.sourceFile || deck.sourceFile, sourceSha256: deck.sha256, sourcePageCount: deck.pageCount })));
}

export function buildTemplateContract({ pages = [], sourceMetadata = {} } = {}) {
  const metadataById = new Map(normalizeSourceMetadata(sourceMetadata).map(page => [String(page.pageId || `${page.deckId}-p${String(page.page).padStart(3, "0")}`), page]));
  const templates = pages.map(page => {
    const pageId = String(page.id || `${page.deckId}-p${String(page.sourcePage).padStart(3, "0")}`);
    const metadata = metadataById.get(pageId) || {};
    const title = clean(metadata.title || page.title);
    const blocks = Array.isArray(metadata.textBlocks) && metadata.textBlocks.length
      ? metadata.textBlocks
      : [{ text: title, placeholder: "title" }, ...(clean(metadata.allText || page.extractedText).split(/\n+/).filter(Boolean).slice(1).map(text => ({ text })) )];
    const slots = blocks.map((block, index) => slotFor(block, index, title));
    const titleSlot = slots.find(slot => slot.kind === "title") || slots[0] || null;
    const bodySlots = slots.filter(slot => slot.kind === "body");
    return {
      pageId,
      sourceFile: String(page.sourceFile || metadata.sourceFile || ""),
      sourcePage: Number(page.sourcePage || metadata.page || 0),
      sourceSha256: metadata.sourceSha256 || null,
      pageRole: pageRole(page),
      title: { text: title, slotId: titleSlot?.slotId || null, capacity: titleSlot?.capacity || slotCapacity(title, "title"), editable: Boolean(titleSlot?.editable ?? true) },
      body: bodySlots.map(slot => ({ slotId: slot.slotId, text: slot.originalText, capacity: slot.capacity, editable: slot.editable })),
      textSlots: slots,
      requiredObjects: slots.filter(slot => slot.mustPreserveObject).map(slot => slot.slotId),
      oldCopyFingerprints: slots.filter(slot => slot.originalText).map(slot => ({ slotId: slot.slotId, sha256: slot.originalTextFingerprint })),
      editableConstraints: {
        titleSlotId: titleSlot?.slotId || null,
        bodySlotIds: bodySlots.map(slot => slot.slotId),
        allowedOperations: ["replace-in-place", "clear-body"],
        preserveRequiredObjects: true,
        preserveSourcePage: true,
      },
    };
  });
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: { pages: "data/pages.json", sourceMetadata: "data/source-metadata.json" },
    pageCount: templates.length,
    templates,
  };
}

export async function readTemplateContract(file) {
  const contract = JSON.parse(await fs.readFile(file, "utf8"));
  if (!contract || contract.version !== VERSION || !Array.isArray(contract.templates)) throw new Error("无效的 template contract");
  return contract;
}

export function findTemplatePage(contract, { pageId, sourceFile, sourcePage } = {}) {
  const pages = Array.isArray(contract?.templates) ? contract.templates : [];
  return pages.find(page => pageId && page.pageId === pageId)
    || pages.find(page => sourceFile && path.basename(page.sourceFile) === path.basename(sourceFile) && Number(page.sourcePage) === Number(sourcePage))
    || null;
}

export function validateTemplateContent(template, { title = "", body = [] } = {}) {
  if (!template) return { ok: true, issues: [] };
  const issues = [];
  const titleLimit = Number(template.title?.capacity?.hardMaxChars || 180);
  if (clean(title).length > titleLimit) issues.push(`标题超过模板硬容量 ${titleLimit} 字符`);
  const bodyValues = Array.isArray(body) ? body : [body];
  const bodySlots = Array.isArray(template.body) ? template.body : [];
  bodyValues.forEach((value, index) => {
    const limit = Number(bodySlots[index]?.capacity?.hardMaxChars || 1200);
    if (clean(value).length > limit) issues.push(`第 ${index + 1} 个正文槽超过模板硬容量 ${limit} 字符`);
  });
  return { ok: issues.length === 0, issues };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith("--") ? [arg.slice(2), all[index + 1]] : []).filter(item => item.length));
  const root = path.resolve(args.root || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
  const pages = JSON.parse(await fs.readFile(path.resolve(root, args.pages || "data/pages.json"), "utf8"));
  const sourceMetadata = JSON.parse(await fs.readFile(path.resolve(root, args["source-metadata"] || "data/source-metadata.json"), "utf8"));
  const contract = buildTemplateContract({ pages, sourceMetadata });
  const out = path.resolve(root, args.out || "data/template-contract.json");
  await fs.writeFile(out, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ version: contract.version, pageCount: contract.pageCount, output: out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
