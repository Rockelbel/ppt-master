import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveCustomerMissingInputs, extractCustomerMaterials } from "./extract_customer_materials.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-master-materials-"));
try {
  const taskId = "rewrite-test-materials";
  const dir = path.join(root, ".tmp", "customer-rewrite-materials", taskId);
  await fs.mkdir(dir, { recursive: true });
  const textPath = path.join(dir, "客户资料.txt");
  const csvPath = path.join(dir, "客户数据.csv");
  const pdfPath = path.join(dir, "品牌规范.pdf");
  await fs.writeFile(textPath, "客户所属快消饮料行业。\n\n当前痛点是费用报销效率低。\n", "utf8");
  await fs.writeFile(csvPath, "指标,数据\n员工,1200\n覆盖城市,30\n", "utf8");
  await fs.writeFile(pdfPath, "%PDF-test", "utf8");
  const materials = [
    { id: "material-text", name: "客户资料.txt", kind: "text", source: "upload", path: path.relative(root, textPath) },
    { id: "material-csv", name: "客户数据.csv", kind: "text", source: "upload", path: path.relative(root, csvPath) },
    { id: "material-pdf", name: "品牌规范.pdf", kind: "document", source: "upload", path: path.relative(root, pdfPath) },
  ];
  const result = await extractCustomerMaterials({ root, taskId, materials });
  assert.equal(result.status, "partial");
  assert.equal(result.totalMaterials, 3);
  assert.equal(result.extractedMaterials, 2);
  assert.equal(result.unsupportedMaterials, 1);
  assert.ok(result.evidence.some(item => item.sourceFile === "客户资料.txt" && item.lineStart === 1));
  assert.ok(result.evidence.some(item => item.sourceFile === "客户数据.csv" && item.lineStart === 2 && item.row === 2));
  assert.match(result.evidence[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(result.evidence[0].version, `sha256:${result.evidence[0].hash}`);
  assert.equal(result.materials.find(item => item.id === "material-pdf")?.extractStatus, "unsupported");
  assert.ok(result.materials.every(item => item.extractPath));
  assert.deepEqual(deriveCustomerMissingInputs({ targetLogoPath: "logo.png", evidence: result.evidence }), []);
  assert.deepEqual(deriveCustomerMissingInputs({ evidence: [] }), ["目标客户行业背景", "客户现状与痛点", "可引用案例或数据", "客户 Logo/品牌素材"]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, result.manifestPath), "utf8"));
  assert.equal(manifest.evidenceCount, result.evidence.length);
  const evidenceFile = JSON.parse(await fs.readFile(path.join(root, result.evidencePath), "utf8"));
  assert.equal(evidenceFile.evidence.length, result.evidence.length);
  for (const material of result.materials) await fs.stat(path.join(root, material.extractPath));
  console.log("customer material extraction tests passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
