import assert from "node:assert/strict";
import { planCustomerGapPages } from "./plan_customer_gap_pages.mjs";

const withoutEvidence = planCustomerGapPages({
  changePlan: [{ page: 2, title: "客户现状与痛点", action: "pending" }],
  evidence: [],
  missingInputs: ["目标客户行业背景", "客户现状与痛点", "可引用案例或数据"],
});
assert.equal(withoutEvidence.gapPagePlan.length, 4);
assert.equal(withoutEvidence.summary.pending, 4);
for (const page of withoutEvidence.gapPagePlan) {
  assert.equal(page.action, "pending");
  assert.deepEqual(page.evidenceIds, []);
  assert.equal("factDrafts" in page, false, "没有证据的待补页面不得包含事实内容");
}

const evidence = [
  { id: "ev-background", text: "可口可乐属于快消饮料行业，业务覆盖多个区域。" },
  { id: "ev-pain", text: "客户当前痛点是费用报销效率低，管理成本较高。" },
  { id: "ev-data", text: "现有资料显示员工 1200 人，业务覆盖 30 个城市。" },
  { id: "ev-next", text: "下一步计划先确认方案，再安排试点和上线时间表。" },
];
const planned = planCustomerGapPages({
  changePlan: [{ page: 7, title: "客户现状分析", action: "rewrite" }],
  evidence,
  missingInputs: [],
});
assert.deepEqual(planned.gapPagePlan.map(item => item.id), ["customer-background", "customer-pain", "customer-case-data", "customer-next-step"]);
assert.equal(planned.gapPagePlan.find(item => item.id === "customer-pain")?.action, "rewrite");
assert.deepEqual(planned.gapPagePlan.find(item => item.id === "customer-pain")?.sourcePageNumbers, [7]);
assert.equal(planned.summary.pending, 0);
assert.equal(planned.summary.rewrite, 1);
assert.equal(planned.summary.create, 3);
for (const page of planned.gapPagePlan) {
  assert.ok(page.evidenceIds.length > 0, `${page.id} 应绑定证据`);
  assert.ok(page.factDrafts.length > 0, `${page.id} 应只复制证据片段作为事实草稿`);
  assert.ok(page.factDrafts.every(item => page.evidenceIds.includes(item.evidenceId)));
}

const pendingSource = planCustomerGapPages({
  changePlan: [{ page: 7, title: "客户现状分析", action: "pending" }],
  evidence,
  missingInputs: [],
});
assert.equal(pendingSource.gapPagePlan.find(item => item.id === "customer-pain")?.action, "create");
assert.deepEqual(pendingSource.gapPagePlan.find(item => item.id === "customer-pain")?.sourcePageNumbers, []);

const stillMissing = planCustomerGapPages({ evidence, missingInputs: ["客户现状与痛点"] });
const blockedPain = stillMissing.gapPagePlan.find(item => item.id === "customer-pain");
assert.equal(blockedPain.action, "pending");
assert.ok(blockedPain.evidenceIds.includes("ev-pain"), "有部分证据时仍需保留证据引用");
assert.equal("factDrafts" in blockedPain, false, "missingInputs 未解除时不得输出事实草稿");

console.log("customer gap page planning tests passed");
