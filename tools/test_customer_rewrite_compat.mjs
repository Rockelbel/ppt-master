import assert from "node:assert/strict";
import { normalizeCustomerRewriteTask } from "./customer_rewrite_compat.mjs";

const legacy = {
  id: "rewrite-legacy-001",
  name: "历史客户方案.pptx",
  sourceCustomer: "中国移动",
  targetCustomer: "可口可乐",
  status: "done",
  progress: "100",
  metrics: { processedPages: "106" },
  source: { type: "upload", name: "历史客户方案.pptx", path: ".tmp/customer-rewrite-uploads/source.pptx" },
  materials: [{ name: "品牌规范.pdf", kind: "document", source: "upload" }],
  createdAt: "2026-08-20T00:00:00.000Z",
};
const before = JSON.stringify(legacy);
const normalized = normalizeCustomerRewriteTask(legacy);

assert.equal(JSON.stringify(legacy), before, "兼容归一化不能修改从历史文件读取的对象");
assert.equal(normalized.status, "completed");
assert.equal(normalized.deliveryStatus, "process");
assert.equal(normalized.planVersion, 0);
assert.equal(normalized.outputVersion, 0);
assert.deepEqual(normalized.operationLog, []);
assert.equal(normalized.source.type, "upload");
assert.equal(normalized.materials[0].name, "品牌规范.pdf");
assert.equal(normalized.qualityGate, null);
assert.equal(normalized.quality, null);
assert.deepEqual(normalized.changePlan, []);
assert.deepEqual(normalized.missingInputs, []);
assert.deepEqual(normalized.evidence, []);
assert.equal(normalized.materialEvidence, null);
assert.equal(normalized.materialExtraction, null);
assert.deepEqual(normalized.residuals, []);
assert.deepEqual(normalized.metrics, { processedPages: 106, replacedPages: null, retainedPages: null, pendingPages: null, failedPages: null });

const delivered = normalizeCustomerRewriteTask({ id: "rewrite-legacy-002", status: "success", quality: { passed: true } });
assert.equal(delivered.status, "completed");
assert.equal(delivered.deliveryStatus, "deliverable");
assert.equal(delivered.qualityGate?.passed, true);
assert.equal(delivered.quality?.passed, true);

const mixedPlan = normalizeCustomerRewriteTask({
  id: "rewrite-legacy-003",
  changePlan: [{ page: 1, action: "retain" }, { page: null, action: "create" }],
  outputPlan: [{ page: 1, sourcePage: 1, action: "retain" }, { page: null, sourcePage: null, action: "create" }],
});
assert.deepEqual(mixedPlan.changePlan.map(item => item.action), ["retain"]);
assert.equal(mixedPlan.outputPlan.length, 2);

console.log("customer rewrite compatibility tests passed");
