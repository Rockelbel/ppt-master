import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const port = 4400 + (process.pid % 200);
const source = path.join(root, ".tmp", "regression-single-page.pptx");
let output = "";
let child = startServer();

function startServer() {
  const next = spawn(process.execPath, [path.resolve(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", chunk => { output += chunk.toString(); });
  next.stderr.on("data", chunk => { output += chunk.toString(); });
  return next;
}

async function stopServer() {
  if (!child || child.killed) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/pages?page=1&pageSize=1`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`客户化服务启动失败：${output}`);
}

async function getTask(id) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/customer-rewrite/${encodeURIComponent(id)}`)).json()).task;
}

try {
  await fs.access(source);
  await waitForServer();
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(source)], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), "regression-single-page.pptx");
  form.append("targetCustomer", "回归客户");
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/customer-rewrite`, { method: "POST", body: form });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  const id = created.task.id;
  const deadline = Date.now() + 60_000;
  let task;
  while (Date.now() < deadline) {
    task = await getTask(id);
    if (["review", "completed", "failed"].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(task.status, "review");
  assert.equal(task.planConfirmed, false);
  assert.equal(task.outputPath, null);
  assert.equal(task.previewPath, null);
  assert.equal(task.exportUrl, null);
  assert.ok(task.changePlan.length >= 1);

  // Restart must preserve the review boundary: an unconfirmed plan cannot
  // resume into rewriting or expose an output after process recovery.
  await stopServer();
  child = startServer();
  await waitForServer();
  task = await getTask(id);
  assert.equal(task.status, "review");
  assert.equal(task.planConfirmed, false);
  assert.equal(task.outputPath, null);
  assert.equal(task.previewPath, null);
  assert.equal(task.exportUrl, null);

  const plan = task.changePlan.map(item => ({ page: item.page, action: "retain" }));
  const planResponse = await fetch(`http://127.0.0.1:${port}/api/customer-rewrite/${encodeURIComponent(id)}/plan`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pages: plan, confirm: true }),
  });
  assert.equal(planResponse.status, 200);
  const rerunResponse = await fetch(`http://127.0.0.1:${port}/api/customer-rewrite/${encodeURIComponent(id)}/rerun`, { method: "POST" });
  assert.equal(rerunResponse.status, 202);
  const rerunDeadline = Date.now() + 120_000;
  while (Date.now() < rerunDeadline) {
    task = await getTask(id);
    if (["review", "completed", "failed"].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(["review", "completed"].includes(task.status));
  assert.equal(task.planConfirmed, true);
  assert.equal(task.planVersion, 1);
  assert.ok(task.outputPath);
  assert.ok(task.previewPath);
  assert.ok(task.exportUrl);
  await fs.access(path.join(root, task.outputPath));
  await fs.access(path.join(root, task.previewPath));
  console.log("customer rewrite flow regression: ok");
} finally {
  await stopServer();
}
