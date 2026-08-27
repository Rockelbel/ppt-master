#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const outputDir = path.join(root, ".tmp", "feishu-knowledge");
const registryPath = path.join(root, "data", "source-registry.json");
const knowledgePath = path.join(root, "data", "feishu-documents.json");
const cliEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
const queries = ["分贝通 产品", "商旅 费控", "AI Agent", "服务 SLA", "客户案例", "销售方案", "产品介绍", "降本 管控"];
const explicitDocs = [
  { url: "https://fenbeitong.feishu.cn/wiki/MY7KwN8k0ivNDwkxZNNcynVfnnd", title: "服务等级协议" },
  { url: "https://fenbeitong.feishu.cn/wiki/VNv5wg7O1iV3PHkP6DUciy24nvR", title: "管控Agent" },
];
const stripHighlight = value => String(value || "").replace(/<\/?h[b]?\>/g, "").replace(/&amp;/g, "&").replace(/&#34;/g, '"').trim();

async function cli(args) {
  const { stdout } = await execFileAsync("lark-cli", args, { cwd: root, env: cliEnv, maxBuffer: 12 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function resultToSource(result) {
  const meta = result.result_meta || {};
  let iconInfo = {};
  try { iconInfo = meta.icon_info ? JSON.parse(meta.icon_info) : {}; } catch {}
  const title = stripHighlight(result.title_highlighted || result.title);
  const url = meta.url || "";
  const ownTenant = /fenbeitong\.feishu\.cn/i.test(url);
  const titleText = title.toLowerCase();
  let score = ownTenant ? 20 : 0;
  for (const term of ["产品", "介绍", "agent", "ai", "商旅", "费控", "销售", "方案", "案例", "服务", "sla", "降本", "管控", "黄宝书", "帮助中心"]) {
    if (titleText.includes(term)) score += 3;
  }
  for (const term of ["prd", "周报", "述职", "启动会", "市场调研", "竞品", "技术方案", "复盘"]) {
    if (titleText.includes(term)) score -= 2;
  }
  return {
    token: meta.token,
    url,
    title,
    entityType: result.entity_type || "",
    docType: meta.doc_types || "",
    ownerName: meta.owner_name || "",
    ownerId: meta.owner_id || "",
    revisionId: Number(iconInfo.version) || null,
    updateTime: meta.update_time_iso || null,
    summary: stripHighlight(result.summary_highlighted || ""),
    score,
    searchQueries: [],
  };
}

const searchResults = await Promise.all(queries.map(async query => {
  try {
    const payload = await cli(["drive", "+search", "--as", "user", "--query", query, "--doc-types", "docx,doc,wiki", "--page-size", "20", "--format", "json"]);
    return (payload.data?.results || []).map(item => ({ item, query }));
  } catch (error) {
    console.warn(`Search failed for ${query}: ${error.message}`);
    return [];
  }
}));

const byToken = new Map();
for (const { item, query } of searchResults.flat()) {
  const source = resultToSource(item);
  if (!source.token || !source.url) continue;
  const existing = byToken.get(source.token);
  if (existing) {
    existing.score += source.score;
    existing.searchQueries.push(query);
  } else {
    source.searchQueries.push(query);
    byToken.set(source.token, source);
  }
}

const candidates = [...byToken.values()].sort((a, b) => b.score - a.score || String(b.updateTime).localeCompare(String(a.updateTime)));
for (const item of explicitDocs) {
  if (![...byToken.values()].some(source => source.url === item.url)) byToken.set(item.url, { token: item.url.split("/").pop(), url: item.url, title: item.title, entityType: "WIKI", docType: "DOCX", ownerName: "", ownerId: "", revisionId: null, updateTime: null, summary: "", score: 100, searchQueries: ["explicit"] });
}
const ranked = [...byToken.values()].sort((a, b) => b.score - a.score || String(b.updateTime).localeCompare(String(a.updateTime)));
const explicitSources = explicitDocs.map(item => [...byToken.values()].find(source => source.url === item.url)).filter(Boolean);
const selected = [...new Map([...ranked.slice(0, 36), ...explicitSources].map(source => [source.url, source])).values()];
const documents = [];
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const source = selected[cursor++];
    try {
      const payload = await cli(["docs", "+fetch", "--as", "user", "--doc", source.url, "--doc-format", "markdown", "--scope", "full", "--detail", "simple", "--format", "json"]);
      const document = payload.data?.document || {};
      const content = String(document.content || "").trim();
      documents.push({
        ...source,
        fetched: true,
        fetchedAt: new Date().toISOString(),
        revisionId: document.revision_id ?? source.revisionId,
        content,
        contentChars: content.length,
        fetchError: null,
      });
      console.log(`Fetched ${documents.length}/${selected.length}: ${source.title}`);
    } catch (error) {
      documents.push({ ...source, fetched: false, fetchedAt: new Date().toISOString(), content: "", contentChars: 0, fetchError: error.message });
      console.warn(`Fetch failed: ${source.title}: ${error.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
documents.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));

await fs.mkdir(outputDir, { recursive: true });
for (const document of documents) {
  const safe = document.token.replace(/[^a-zA-Z0-9_-]/g, "_");
  await fs.writeFile(path.join(outputDir, `${safe}.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
await fs.writeFile(knowledgePath, `${JSON.stringify({ version: "feishu-documents-v1", fetchedAt: new Date().toISOString(), queries, candidateCount: candidates.length, selectedCount: selected.length, documents }, null, 2)}\n`, "utf8");
await fs.writeFile(registryPath, `${JSON.stringify({ version: "source-registry-v1", updatedAt: new Date().toISOString(), sources: documents.map(({ content, ...source }) => ({ ...source, sourceKind: "feishu-doc" })) }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ candidates: candidates.length, selected: selected.length, fetched: documents.filter(item => item.fetched).length, failed: documents.filter(item => !item.fetched).length, output: "data/feishu-documents.json" }));
