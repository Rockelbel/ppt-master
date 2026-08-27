#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCustomerRewrite } from "./check_customer_rewrite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "source_ppts", "中国移动-分贝通企业支出管理解决方案V4.pptx");
const pageCount = 106;
const plan = Array.from({ length: pageCount }, (_, index) => ({
  page: index + 1,
  title: `页面 ${index + 1}`,
  role: index === 0 ? "cover" : index === 1 ? "toc" : index === pageCount - 1 ? "closing" : "content",
  action: "retain",
}));

const baseline = await checkCustomerRewrite({
  pptx: source,
  sourcePptx: source,
  customization: { sourceCustomer: "", targetCustomer: "测试客户", slideCount: pageCount, changePlan: plan },
});
assert.equal(baseline.status, "passed");
assert.equal(baseline.planMapping.length, pageCount);
assert.equal(baseline.roleCompleteness.validOrder, true);

const broken = await checkCustomerRewrite({
  pptx: source,
  sourcePptx: source,
  sourceCustomer: "中国移动",
  customization: {
    sourceCustomer: "中国移动", targetCustomer: "测试客户", slideCount: pageCount,
    evidence: [{ id: "evidence-1" }],
    changePlan: [
      { page: 1, title: "待补充标题", role: "content", action: "retain", claims: [{ text: "客户规模" }] },
      { page: 3, title: "重复", description: "重复", role: "closing", action: "rewrite", claims: [{ text: "客户行业", evidenceId: "missing-evidence" }] },
    ],
    replacements: [{ before: "分贝通企业支出管理解决方案" }],
  },
});
const codes = new Set(broken.issues.map(item => item.code));
for (const code of ["incomplete-plan-mapping", "plan-output-count-mismatch", "missing-cover", "missing-toc", "placeholder-title", "title-body-duplicate", "facts-without-evidence", "unknown-evidence-id", "source-customer-residual", "old-copy-residual"]) assert.ok(codes.has(code), `missing ${code}`);
assert.equal(broken.status, "failed");

const unsupported = await checkCustomerRewrite({
  pptx: source,
  sourcePptx: source,
  sourceCustomer: "中国移动",
  customization: {
    sourceCustomer: "中国移动", targetCustomer: "测试客户", slideCount: pageCount,
    changePlan: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1, title: `页面 ${index + 1}`, role: index === 0 ? "cover" : index === pageCount - 1 ? "closing" : "content",
      action: index === 2 ? "rewrite" : "retain", sourceCustomerMention: index === 2,
      replacements: index === 2 ? [{ before: "中国移动当前组织规模和客户专属流程数据与实施结果" }] : [],
    })),
  },
});
assert.ok(unsupported.issues.some(item => item.code === "unsupported-customer-rewrite"));
console.log("check_customer_rewrite tests passed");
