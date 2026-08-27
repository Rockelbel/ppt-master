import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const port = 4327;
const child = spawn(process.execPath, [path.resolve("server.mjs")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/pages?page=1&pageSize=12`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`分页服务启动失败：${output}`);
}

try {
  await waitForServer();
  const first = await fetch(`http://127.0.0.1:${port}/api/pages?page=1&pageSize=12`).then(response => response.json());
  assert.equal(first.pageSize, 12);
  assert.equal(first.items.length, 12);
  assert.ok(first.total >= first.items.length);
  assert.ok(first.totalPages > 1);
  assert.ok(first.counts.all >= first.total);
  assert.ok(Array.isArray(first.facets.scene));

  const filtered = await fetch(`http://127.0.0.1:${port}/api/pages?page=1&pageSize=48&scene=${encodeURIComponent("酒店")}`).then(response => response.json());
  assert.ok(filtered.items.every(page => (page.sceneTags || []).includes("酒店") || (page.scenarios || []).includes("酒店")));

  const id = first.items[0].id;
  const byId = await fetch(`http://127.0.0.1:${port}/api/pages?ids=${encodeURIComponent(id)}`).then(response => response.json());
  assert.deepEqual(byId.items.map(page => page.id), [id]);
  console.log("library pagination regression: ok");
} finally {
  child.kill("SIGTERM");
}
