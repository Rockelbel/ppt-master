import assert from "node:assert/strict";
import { validateReferencePageContent } from "./reference_page_validation.mjs";

const context = {
  referencePage: { title: "竞争优势-概述：一体化企业支出管理平台，众多解决方案皆行业首创" },
  referenceLines: ["原标题", "产品定位", "整体解决方案", "分贝通"],
  message: "修改标题，以及正文的内容，标题缩短点，正文再扩充一点呢",
};
assert.throws(() => validateReferencePageContent({ title: context.referencePage.title, body: ["产品定位", "整体解决方案", "分贝通"] }, context), /缩短页面标题/);
assert.throws(() => validateReferencePageContent({ title: "一体化支出管理平台", body: ["产品定位", "整体解决方案", "分贝通"] }, context), /栏目名/);
assert.throws(() => validateReferencePageContent({ title: "一体化支出管理平台", body: ["简短内容"] }, context), /扩充页面正文/);
validateReferencePageContent({ title: "一体化支出管理平台", body: ["分贝通通过商旅、费控与支付一体化覆盖企业费用支出全流程。", "平台提供预算、事前管控、事后报销和统一结算能力，形成完整管理闭环。"] }, context);
console.log("reference page validation self-check passed");
