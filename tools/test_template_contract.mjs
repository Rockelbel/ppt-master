import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTemplateContract, findTemplatePage, readTemplateContract, validateTemplateContent } from "./template_contract.mjs";

const contract = buildTemplateContract({
  pages: [{ id: "deck-01-p001", deckId: "deck-01", sourceFile: "demo.pptx", sourcePage: 1, title: "标题", pageRole: "cover" }],
  sourceMetadata: { "deck-01": { sourceFile: "demo.pptx", sha256: "abc", pageCount: 1, pages: [{ page: 1, pageId: "deck-01-p001", title: "标题", textBlocks: [{ text: "标题", placeholder: "title" }, { text: "正文内容", placeholder: null }] }] } },
});
assert.equal(contract.version, "template-contract-v1");
assert.equal(contract.pageCount, 1);
const page = findTemplatePage(contract, { sourceFile: "demo.pptx", sourcePage: 1 });
assert.equal(page.pageId, "deck-01-p001");
assert.equal(page.pageRole, "cover");
assert.equal(page.title.slotId, "title-1");
assert.equal(page.body[0].slotId, "body-2");
assert.equal(page.textSlots[0].originalTextFingerprint.startsWith("sha256:"), true);
assert.deepEqual(validateTemplateContent(page, { title: "新标题", body: ["新的正文"] }), { ok: true, issues: [] });
assert.equal(validateTemplateContent(page, { title: "x".repeat(181) }).ok, false);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "template-contract-"));
const file = path.join(temp, "contract.json");
await fs.writeFile(file, JSON.stringify(contract), "utf8");
assert.equal((await readTemplateContract(file)).templates[0].pageId, "deck-01-p001");
await fs.rm(temp, { recursive: true, force: true });
console.log("template contract regression: ok");
