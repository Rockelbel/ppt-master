import fs from "node:fs/promises";
import path from "node:path";

const GAP_DEFINITIONS = [
  {
    id: "customer-background",
    title: "客户背景",
    purpose: "说明目标客户所属行业、业务范围、经营规模和组织背景",
    evidenceTerms: ["行业", "主营", "业务", "经营", "规模", "区域", "零售", "制造", "快消", "饮料", "物流"],
    pageTerms: ["客户背景", "企业背景", "公司概况", "行业背景", "客户简介"],
    missingTerms: ["目标客户行业背景", "客户背景"],
    requiredInputs: ["目标客户行业、主营业务或经营规模资料"],
  },
  {
    id: "customer-pain",
    title: "客户现状与痛点",
    purpose: "呈现目标客户当前流程、管理问题、业务挑战和改造诉求",
    evidenceTerms: ["现状", "痛点", "问题", "挑战", "诉求", "难点", "低效", "效率", "风险", "成本"],
    pageTerms: ["客户痛点", "现状与痛点", "现状分析", "业务挑战", "客户诉求"],
    missingTerms: ["客户现状与痛点", "客户痛点"],
    requiredInputs: ["目标客户当前流程、问题、挑战或明确诉求"],
  },
  {
    id: "customer-case-data",
    title: "客户案例与数据",
    purpose: "用可核验案例、业务数据或效果指标支撑方案可信度",
    evidenceTerms: ["案例", "数据", "指标", "员工", "收入", "覆盖", "客户数", "城市", "门店", "节省", "提升", "%", "万", "亿"],
    pageTerms: ["客户案例", "案例与数据", "业务数据", "关键指标", "实施效果", "项目成果"],
    missingTerms: ["可引用案例或数据", "客户案例", "客户数据"],
    requiredInputs: ["可公开引用的客户案例、业务规模或效果数据"],
  },
  {
    id: "customer-next-step",
    title: "下一步推进计划",
    purpose: "明确后续沟通、方案确认、试点、实施或上线安排",
    evidenceTerms: ["下一步", "计划", "推进", "试点", "实施", "上线", "里程碑", "会议", "确认", "时间表"],
    pageTerms: ["下一步", "推进计划", "实施计划", "项目计划", "行动计划", "里程碑"],
    missingTerms: ["客户下一步", "下一步推进计划", "实施计划"],
    requiredInputs: ["双方确认的下一步动作、负责人或计划时间"],
  },
];

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean) : [];
}

function includesAny(text, terms) {
  return terms.some(term => text.includes(term));
}

function evidenceText(item) {
  return String(item?.text || item?.content || "").replace(/\s+/g, " ").trim();
}

function evidenceId(item, index) {
  return String(item?.id || item?.evidenceId || `evidence-${index + 1}`);
}

function relatedPages(changePlan, definition) {
  return (Array.isArray(changePlan) ? changePlan : []).filter(item => {
    // A pending or removed source page is not a safe rewrite base. Keep it in
    // the customer rewrite review, but never use it to generate evidence pages.
    if (item?.action !== "rewrite") return false;
    const text = [item?.title, item?.reason, item?.sourceTextPreview, ...strings(item?.targetCustomerInputs)].filter(Boolean).join(" ");
    return includesAny(text, definition.pageTerms);
  });
}

export function planCustomerGapPages({ changePlan = [], evidence = [], missingInputs = [] } = {}) {
  const normalizedEvidence = (Array.isArray(evidence) ? evidence : [])
    .map((item, index) => ({ ...item, id: evidenceId(item, index), text: evidenceText(item) }))
    .filter(item => item.text);
  const missing = strings(missingInputs);
  const gapPagePlan = GAP_DEFINITIONS.map(definition => {
    const matches = normalizedEvidence.filter(item => includesAny(item.text, definition.evidenceTerms)).slice(0, 8);
    const sourcePages = relatedPages(changePlan, definition);
    const explicitlyMissing = missing.some(item => includesAny(item, definition.missingTerms));
    const hasEvidence = matches.length > 0;
    const pending = explicitlyMissing || !hasEvidence;
    const base = {
      id: definition.id,
      title: definition.title,
      purpose: definition.purpose,
      action: pending ? "pending" : sourcePages.length ? "rewrite" : "create",
      evidenceIds: matches.map(item => item.id),
      sourcePageNumbers: sourcePages.map(item => Number(item.page)).filter(Number.isInteger),
      requiredInputs: pending ? definition.requiredInputs : [],
      reason: explicitlyMissing
        ? `资料清单仍标记缺少：${missing.filter(item => includesAny(item, definition.missingTerms)).join("、")}`
        : !hasEvidence
          ? "没有可追溯证据，禁止生成目标客户事实"
          : sourcePages.length
            ? "已有相关源页面，使用证据驱动改写"
            : "已有可追溯证据，需要按公司模板新建缺口页",
    };
    // Pending pages deliberately contain no factualContent/factDrafts field.
    // Evidence excerpts are copied verbatim, never promoted into claims without
    // a later generation and review step.
    if (!pending) {
      base.factDrafts = matches.map(item => ({ evidenceId: item.id, text: item.text }));
    }
    return base;
  });
  return {
    version: 1,
    gapPagePlan,
    summary: {
      total: gapPagePlan.length,
      create: gapPagePlan.filter(item => item.action === "create").length,
      rewrite: gapPagePlan.filter(item => item.action === "rewrite").length,
      pending: gapPagePlan.filter(item => item.action === "pending").length,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) throw new Error("用法：node plan_customer_gap_pages.mjs <input.json> [output.json]");
  const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
  const result = planCustomerGapPages(input);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await fs.writeFile(path.resolve(outputPath), json, "utf8");
  else process.stdout.write(json);
}
