import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);
const MAX_SNIPPETS_PER_MATERIAL = 100;
const MAX_TOTAL_EVIDENCE_CHARS = 120_000;
const MAX_SNIPPET_CHARS = 1_200;

function safeId(value) {
  const text = String(value || "material").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (text || "material").slice(0, 80);
}

function isWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function truncateText(value, max = MAX_SNIPPET_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max - 1).trim()}…`, truncated: true };
}

function lineSnippets(content, extension) {
  const lines = String(content || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const snippets = [];
  if (extension === ".csv") {
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      const result = truncateText(lines[index]);
      snippets.push({ text: result.text, lineStart: index + 1, lineEnd: index + 1, truncated: result.truncated });
    }
    return snippets;
  }

  let start = null;
  let buffer = [];
  const flush = end => {
    if (!buffer.length || start === null) return;
    const result = truncateText(buffer.join(" "));
    snippets.push({ text: result.text, lineStart: start, lineEnd: end, truncated: result.truncated });
    start = null;
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      flush(index);
      continue;
    }
    if (start === null) start = index + 1;
    buffer.push(line);
    // Keep long paragraphs bounded while retaining the source line range.
    if (buffer.join(" ").length >= MAX_SNIPPET_CHARS) flush(index + 1);
  }
  flush(lines.length);
  return snippets;
}

function unsupportedResult(material, error) {
  return {
    id: String(material.id || ""),
    name: String(material.name || "未命名资料"),
    kind: material.kind || "unknown",
    source: material.source || "upload",
    path: material.path || null,
    extractStatus: "unsupported",
    snippetCount: 0,
    extractedChars: 0,
    snippets: [],
    error: { code: error.code || "unsupported-format", message: String(error.message || error) },
    extractedAt: new Date().toISOString(),
  };
}

async function extractOneMaterial(root, material, evidenceBudget) {
  const name = String(material.name || "");
  const extension = path.extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    return { result: unsupportedResult(material, new Error("第一版只抽取 TXT、MD、CSV 文本资料，其他格式暂不读取")), evidence: [] };
  }
  const candidate = path.resolve(root, String(material.path || ""));
  if (!material.path || !isWithinRoot(root, candidate)) {
    return { result: unsupportedResult(material, Object.assign(new Error("资料路径不在任务工作目录内"), { code: "invalid-path" })), evidence: [] };
  }
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) throw Object.assign(new Error("资料路径不是文件"), { code: "not-a-file" });
    const raw = await fs.readFile(candidate);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const version = `sha256:${hash}`;
    const content = raw.toString("utf8");
    const rawSnippets = lineSnippets(content, extension).slice(0, MAX_SNIPPETS_PER_MATERIAL);
    const snippets = [];
    const evidence = [];
    let extractedChars = 0;
    for (const snippet of rawSnippets) {
      if (!snippet.text || evidenceBudget.remaining <= 0) break;
      const remaining = Math.max(0, evidenceBudget.remaining);
      const bounded = truncateText(snippet.text, Math.min(MAX_SNIPPET_CHARS, remaining));
      if (!bounded.text) break;
      const evidenceId = `${material.id || crypto.randomUUID()}#${snippet.lineStart}-${snippet.lineEnd}`;
      const item = {
        id: evidenceId,
        materialId: String(material.id || ""),
        sourceFile: name,
        sourcePath: material.path || null,
        kind: material.kind || "text",
        hash,
        version,
        text: bounded.text,
        lineStart: snippet.lineStart,
        lineEnd: snippet.lineEnd,
        ...(extension === ".csv" ? { row: snippet.lineStart } : {}),
        truncated: Boolean(snippet.truncated || bounded.truncated),
      };
      snippets.push(item);
      evidence.push(item);
      extractedChars += bounded.text.length;
      evidenceBudget.remaining -= bounded.text.length;
    }
    const extractStatus = snippets.length ? "extracted" : content.trim() ? "truncated" : "empty";
    return {
      result: {
        id: String(material.id || ""),
        name,
        kind: material.kind || "text",
        source: material.source || "upload",
        path: material.path || null,
        hash,
        version,
        extractStatus,
        snippetCount: snippets.length,
        extractedChars,
        snippets,
        error: null,
        extractedAt: new Date().toISOString(),
      },
      evidence,
    };
  } catch (error) {
    return {
      result: {
        ...unsupportedResult(material, Object.assign(new Error(`读取资料失败：${error.message}`), { code: error.code || "read-failed" })),
        extractStatus: "failed",
      },
      evidence: [],
    };
  }
}

export function deriveCustomerMissingInputs({ targetLogoPath = null, evidence = [] } = {}) {
  const text = evidence.map(item => String(item.text || "")).join("\n");
  const has = terms => terms.some(term => text.includes(term));
  const missing = [];
  if (!has(["行业", "主营", "业务", "经营", "零售", "制造", "快消", "饮料", "物流"])) missing.push("目标客户行业背景");
  if (!has(["现状", "痛点", "问题", "挑战", "诉求", "目标"])) missing.push("客户现状与痛点");
  if (!has(["案例", "数据", "指标", "规模", "收入", "员工", "覆盖", "客户数"])) missing.push("可引用案例或数据");
  if (!targetLogoPath) missing.push("客户 Logo/品牌素材");
  return missing;
}

export async function extractCustomerMaterials({ root, taskId, materials = [] } = {}) {
  const list = Array.isArray(materials) ? materials.slice(0, 20) : [];
  if (!list.length) {
    return { status: "none", totalMaterials: 0, extractedMaterials: 0, unsupportedMaterials: 0, failedMaterials: 0, evidence: [], materials: [], manifestPath: null };
  }
  const materialDir = path.join(root, ".tmp", "customer-rewrite-materials", safeId(taskId));
  await fs.mkdir(materialDir, { recursive: true });
  const evidenceBudget = { remaining: MAX_TOTAL_EVIDENCE_CHARS };
  const results = [];
  const evidence = [];
  for (const material of list) {
    const extracted = await extractOneMaterial(root, material, evidenceBudget);
    results.push(extracted.result);
    evidence.push(...extracted.evidence);
    const filePath = path.join(materialDir, `material-extract-${safeId(material.id)}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(extracted.result, null, 2)}\n`, "utf8");
    extracted.result.extractPath = path.relative(root, filePath);
  }
  const extractedCount = results.filter(item => item.extractStatus === "extracted" || item.extractStatus === "truncated").length;
  const failedCount = results.filter(item => item.extractStatus === "failed").length;
  const unsupportedCount = results.filter(item => item.extractStatus === "unsupported").length;
  const manifest = {
    version: 1,
    taskId: String(taskId || ""),
    status: failedCount
      ? (extractedCount ? "partial" : "failed")
      : unsupportedCount ? (extractedCount ? "partial" : "unsupported")
      : "completed",
    totalMaterials: results.length,
    extractedMaterials: extractedCount,
    unsupportedMaterials: unsupportedCount,
    failedMaterials: failedCount,
    evidenceCount: evidence.length,
    evidenceChars: evidence.reduce((sum, item) => sum + String(item.text || "").length, 0),
    materials: results,
    evidence,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(materialDir, "material-extract.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const evidencePath = path.join(materialDir, "evidence.json");
  await fs.writeFile(evidencePath, `${JSON.stringify({ version: 1, taskId: manifest.taskId, createdAt: manifest.createdAt, evidence }, null, 2)}\n`, "utf8");
  return { ...manifest, manifestPath: path.relative(root, manifestPath), evidencePath: path.relative(root, evidencePath) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, taskId, materialsPath] = process.argv.slice(2);
  if (!root || !taskId || !materialsPath) throw new Error("用法：node extract_customer_materials.mjs <root> <taskId> <materials.json>");
  const materials = JSON.parse(await fs.readFile(materialsPath, "utf8"));
  const result = await extractCustomerMaterials({ root: path.resolve(root), taskId, materials });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
