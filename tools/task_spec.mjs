/*
 * Task specification parsing is deliberately deterministic. The model can
 * enrich the spec later, but page targeting must never depend on a fuzzy
 * keyword match or on a model response.
 */

const CHINESE_DIGITS = Object.freeze({
  零: 0, 〇: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
});

function chineseNumber(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{1,2}$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, char)) {
      current = CHINESE_DIGITS[char];
    } else if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else {
      return null;
    }
  }
  const result = total + current;
  return result > 0 && result <= 99 ? result : null;
}

function pageToken(value) {
  const parsed = chineseNumber(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 99 ? parsed : null;
}

function pageReferenceMatches(text) {
  const matches = [];
  // Keep the complete "第 N 页" span out of count parsing. In particular,
  // this prevents "第二页" from being read as a request for two pages.
  const pattern = /第\s*([0-9]{1,2}|[零〇一两二三四五六七八九十]+)\s*(?:页|张)(?:\s*(?:PPT|幻灯片|页面))?/giu;
  for (const match of String(text || "").matchAll(pattern)) {
    const number = pageToken(match[1]);
    if (number) matches.push({ number, index: match.index, length: match[0].length, text: match[0] });
  }
  return matches;
}

function maskPageReferences(text) {
  const source = String(text || "");
  let masked = source;
  // Replacing with spaces preserves positions but makes quantity extraction
  // unable to see the "二页" suffix inside a page reference.
  for (const item of pageReferenceMatches(source).sort((a, b) => b.index - a.index)) {
    masked = `${masked.slice(0, item.index)}${" ".repeat(item.length)}${masked.slice(item.index + item.length)}`;
  }
  return masked;
}

export function extractPageTargets(message) {
  return pageReferenceMatches(message).map(item => item.number);
}

export function extractRequestedPageCount(message) {
  const text = maskPageReferences(message);
  const matches = [];
  // An unprefixed quantity is a page-count request. A preceding "第" is
  // already masked above, so "第 2 页" and "第二页" cannot match here.
  const pattern = /(?:共|总共|一共|做|生成|制作|创建|新增|添加|输出|需要|给我|请)?\s*([0-9]{1,2}|[零〇一两二三四五六七八九十]+)\s*(?:页|张)(?:\s*(?:PPT|幻灯片|页面))?/giu;
  for (const match of text.matchAll(pattern)) {
    const number = pageToken(match[1]);
    if (number) matches.push(number);
  }
  return matches.length ? matches[0] : null;
}

function includesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

export function parseTaskSpec(message, options = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  const referencePageId = typeof options.referencePageId === "string" && options.referencePageId.trim()
    ? options.referencePageId.trim().slice(0, 160)
    : null;
  const targets = extractPageTargets(text);
  const requestedPageCount = extractRequestedPageCount(text);
  const hasPptContext = /(?:pptx?|powerpoint|幻灯片|页面|方案|预览|牌堆)/iu.test(text);
  const hasCreateVerb = includesAny(text, [/新建/iu, /新做/iu, /生成/iu, /制作/iu, /创建/iu, /从零/iu, /全新/iu, /做一/iu, /做个/iu, /做一套/iu]);
  const hasModifyVerb = includesAny(text, [/修改/iu, /调整/iu, /改成/iu, /改为/iu, /重写/iu, /替换/iu, /重组/iu, /只保留/iu, /不要/iu, /面向/iu]);
  const hasRemoveVerb = includesAny(text, [/删除/iu, /移除/iu, /删掉/iu, /去掉/iu]);
  const hasReorderVerb = includesAny(text, [/调序/iu, /调整[^。！？]{0,8}顺序/iu, /重新排序/iu, /拖拽排序/iu, /交换顺序/iu, /换一下顺序/iu, /页面顺序/iu]);
  const hasExplicitMove = targets.length >= 2 && includesAny(text, [/调整/iu, /移动/iu, /移到/iu, /放到/iu, /换到/iu, /调到/iu]) && /(?:到|至)/u.test(text);
  const reorderPages = targets.length >= 2 ? targets.slice(0, 2) : [];
  const directReuse = includesAny(text, [/直接复用/iu, /直接使用/iu, /原样使用/iu, /不用修改/iu]);
  const appendRequest = includesAny(text, [/加入预览/iu, /添加到预览/iu, /追加/iu, /补充/iu, /再加/iu]);
  const exportRequest = includesAny(text, [/导出(?:pptx?|文件)?/iu, /下载(?:pptx?|文件)?/iu]);
  const customerAdaptation = hasModifyVerb && /(?:上传|提供|给你|这个|该|原始|现有|中国移动|客户)[^。！？]{0,80}(?:pptx?|powerpoint|方案|演示)[^。！？]{0,80}(?:改成|改为|面向|替换为|换成)/iu.test(text)
    || hasModifyVerb && /(?:pptx?|powerpoint|方案|演示)[^。！？]{0,80}(?:改成|改为|面向|替换为|换成)/iu.test(text);
  const draftIds = Array.isArray(options.draftIds) ? options.draftIds.filter(id => typeof id === "string") : [];

  let operation = "chat";
  if (referencePageId) operation = "modify_page";
  else if (exportRequest) operation = "export";
  else if (hasReorderVerb || hasExplicitMove) operation = "reorder";
  else if (hasRemoveVerb) operation = "remove";
  else if (customerAdaptation) operation = "modify_deck";
  else if (hasModifyVerb && (targets.length || draftIds.length || /预览|牌堆/iu.test(text))) operation = "modify";
  else if (directReuse && hasPptContext) operation = "reuse";
  else if (hasCreateVerb || (requestedPageCount && hasPptContext)) operation = requestedPageCount && requestedPageCount > 1 || /(?:整套|全套|完整方案|方案汇报|大方案)/iu.test(text) ? "create_deck" : "create_page";
  else if (includesAny(text, [/推荐/iu, /选页/iu]) || appendRequest) operation = "append";

  const workflow = operation !== "chat";
  const targetPageNumber = targets[0] || null;
  const targetPageNumbers = [...new Set(targets)];
  const isTargetedEdit = operation === "modify" || operation === "remove" || operation === "modify_page";
  const summary = operation === "modify_deck"
    ? "基于用户上传或提供的整套 PPT 修改客户对象"
    : operation === "modify_page" ? `基于引用页面 ${referencePageId} 生成一张新的可编辑页面，原页面保持不变`
      : operation === "modify" ? `只修改预览第 ${targetPageNumber || "指定"} 页，其他页面保持不变`
      : operation === "remove" ? `从当前预览移除${targetPageNumber ? `第 ${targetPageNumber} 页` : "指定页面"}`
        : operation === "reorder" ? "调整当前预览页面顺序"
          : operation === "reuse" ? "直接复用现有页面，不重新生成"
            : operation === "create_deck" ? `新建 ${requestedPageCount} 页 PPT`
              : operation === "create_page" ? "新建一页 PPT"
                : operation === "append" ? "向当前预览追加页面" : "普通对话";

  const uploadedSource = options.sourceType === "uploaded_deck"
    || Boolean(options.sourceFile)
    || /(?:上传|提供|原始|现有)[^。！？]{0,40}(?:pptx?|powerpoint|方案|演示)/iu.test(text)
    || /(?:上传|提供|原始|现有|这个|该)\s*(?:的)?\s*(?:pptx?|powerpoint|方案|演示)/iu.test(text);
  const customerMatch = text.match(/(?:改成|改为|面向|替换为|换成)\s*([^，。！？；;]+)/iu);
  const targetCustomer = customerMatch ? customerMatch[1].trim().replace(/^(?:面向|给|为)\s*/u, "").replace(/(?:进行)?\s*(?:对比|比较)(?:优势)?$/u, "").trim().slice(0, 80) : null;
  return {
    version: 1,
    source: "deterministic",
    mode: workflow ? "workflow" : "chat",
    operation,
    requestedPageCount: operation === "create_page" ? 1 : requestedPageCount,
    targetPageNumber,
    targetPageNumbers,
    reorderFromPageNumber: reorderPages[0] || null,
    reorderToPageNumber: reorderPages[1] || null,
    targetScope: targetPageNumber ? "preview_page" : draftIds.length ? "preview_queue" : "unspecified",
    preserveOtherPages: isTargetedEdit,
    directReuse: operation === "reuse",
    requiresGeneration: ["create_page", "create_deck", "modify", "modify_deck", "modify_page"].includes(operation),
    customerAdaptation,
    inputSource: referencePageId ? "referenced_page" : uploadedSource ? "uploaded_deck" : draftIds.length ? "preview_queue" : "library_or_new",
    targetCustomer,
    referencePageId,
    draftIds,
    summary,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = [
    ["修改预览的第二页，只保留降本和合规", "modify", 2, null],
    ["做两页 PPT 介绍商旅和管控", "create_deck", null, 2],
    ["生成一页全新的整合页面", "create_page", null, 1],
    ["删除预览第 3 页", "remove", 3, null],
    ["调整预览页面顺序", "reorder", null, null],
    ["调整预览第 3 页到第 1 页", "reorder", 3, null],
    ["直接复用资源库中的管控页面", "reuse", null, null],
    ["把中国移动方案改成面向可口可乐", "modify_deck", null, null],
  ];
  for (const [input, operation, target, count] of samples) {
    const spec = parseTaskSpec(input);
    if (spec.operation !== operation || spec.targetPageNumber !== target || spec.requestedPageCount !== count) {
      throw new Error(`task spec self-check failed: ${input} -> ${JSON.stringify(spec)}`);
    }
  }
  if (extractRequestedPageCount("修改预览第二页") !== null) throw new Error("page reference was treated as a count");
  if (extractRequestedPageCount("第 12 页") !== null) throw new Error("spaced page reference was treated as a count");
  const referenced = parseTaskSpec("把这页改成面向可口可乐的版本", { referencePageId: "deck-01-p005" });
  if (referenced.operation !== "modify_page" || referenced.referencePageId !== "deck-01-p005" || referenced.inputSource !== "referenced_page") {
    throw new Error(`reference page task self-check failed: ${JSON.stringify(referenced)}`);
  }
  console.log("task_spec self-check passed");
}
