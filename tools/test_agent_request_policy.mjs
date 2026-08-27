import assert from "node:assert/strict";
import {
  isTargetedPreviewOperation,
  needsPreviewContext,
  shouldUseExternalResearch,
  shouldUseLiveKnowledge,
  shouldUseModelIntent,
} from "./agent_request_policy.mjs";

for (const operation of ["modify", "remove", "reorder"]) {
  const spec = { operation, mode: "workflow" };
  assert.equal(isTargetedPreviewOperation(spec), true);
  assert.equal(shouldUseModelIntent(spec), false);
  assert.equal(shouldUseLiveKnowledge(spec, "workflow"), false);
  assert.equal(shouldUseExternalResearch(spec, "workflow"), false);
}
assert.equal(needsPreviewContext({ operation: "modify" }), true);
assert.equal(needsPreviewContext({ operation: "remove" }), false);
assert.equal(needsPreviewContext({ operation: "reorder" }), false);
assert.equal(shouldUseModelIntent({ operation: "create_page", mode: "workflow" }), true);
assert.equal(shouldUseLiveKnowledge({ operation: "create_page" }, "workflow"), true);
assert.equal(shouldUseExternalResearch({ operation: "chat" }, "chat"), true);
assert.equal(shouldUseExternalResearch({ operation: "create_page" }, "workflow"), true);
console.log("agent request policy regression: ok");
