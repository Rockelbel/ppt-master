import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const candidates = [
  process.env.PRESENTATIONS_ARTIFACT_UTILS,
  process.env.PRESENTATIONS_SKILL_DIR && path.join(process.env.PRESENTATIONS_SKILL_DIR, "container_tools", "artifact_tool_utils.mjs"),
  path.join(os.homedir(), ".codex", "plugins", "cache", "openai-primary-runtime", "presentations", "26.802.11031", "skills", "presentations", "container_tools", "artifact_tool_utils.mjs"),
  path.join(os.homedir(), ".agents", "skills", "presentations", "container_tools", "artifact_tool_utils.mjs"),
].filter(Boolean);
const runtimePath = candidates.find(candidate => fs.existsSync(candidate));
if (!runtimePath) {
  throw new Error("找不到 presentations artifact runtime。请设置 PRESENTATIONS_ARTIFACT_UTILS，或在 Codex 中启用 presentations skill。");
}
const runtime = await import(pathToFileURL(path.resolve(runtimePath)).href);
export const {
  ensureArtifactToolWorkspace,
  importArtifactTool,
  parseArgs,
  requireArg,
  saveBlobToFile,
} = runtime;
