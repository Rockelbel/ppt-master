import assert from "node:assert/strict";
import { applyPreviewOperation, createPreviewSession } from "./preview_state.mjs";

const state = createPreviewSession("test-session", ["a", "b", "c"]);
applyPreviewOperation(state, { type: "append", pageIds: ["d"] }, { expectedVersion: 0 });
assert.deepEqual(state.pageIds, ["a", "b", "c", "d"]);
applyPreviewOperation(state, { type: "replace_at", index: 1, pageId: "x", expectedPageId: "b" }, { expectedVersion: 1 });
assert.deepEqual(state.pageIds, ["a", "x", "c", "d"]);
applyPreviewOperation(state, { type: "reorder", fromIndex: 3, toIndex: 1, expectedPageId: "d" }, { expectedVersion: 2 });
assert.deepEqual(state.pageIds, ["a", "d", "x", "c"]);
applyPreviewOperation(state, { type: "remove_at", index: 2, expectedPageId: "x" }, { expectedVersion: 3 });
assert.deepEqual(state.pageIds, ["a", "d", "c"]);
applyPreviewOperation(state, { type: "replace_all", pageIds: ["z", "z"] }, { expectedVersion: 4 });
assert.deepEqual(state.pageIds, ["z", "z"]);
assert.equal(state.version, 5);
assert.equal(state.operationLog.length, 5);
assert.throws(() => applyPreviewOperation(state, { type: "append", pageIds: ["q"] }, { expectedVersion: 4 }), error => error.statusCode === 409);
assert.throws(() => applyPreviewOperation(state, { type: "replace_at", index: 2, pageId: "q" }, { expectedVersion: 5 }), /超出/);
console.log("preview state regression: ok");
