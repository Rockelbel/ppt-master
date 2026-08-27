import assert from "node:assert/strict";
import { buildPreviewTaskOperation, previewDiff } from "./preview_task_executor.mjs";

const session = { pageIds: ["a", "b", "c"], version: 4 };
assert.deepEqual(buildPreviewTaskOperation({ mode: "workflow", operation: "remove", targetPageNumber: 2 }, session), { type: "remove_at", index: 1, expectedPageId: "b", expectedVersion: 4 });
assert.deepEqual(buildPreviewTaskOperation({ mode: "workflow", operation: "modify", targetPageNumber: 3 }, session), { type: "replace_at", index: 2, expectedPageId: "c", expectedVersion: 4, targetPageId: "c" });
assert.deepEqual(buildPreviewTaskOperation({ mode: "workflow", operation: "reorder", reorderFromPageNumber: 3, reorderToPageNumber: 1 }, session), { type: "reorder", fromIndex: 2, toIndex: 0, expectedPageId: "c", expectedVersion: 4 });
assert.deepEqual(previewDiff(["a", "b"], ["a", "c", "b"]), { before: ["a", "b"], after: ["a", "c", "b"], changed: [{ index: 1, before: "b", after: "c" }, { index: 2, before: null, after: "b" }], added: ["c"], removed: [] });
console.log("preview task executor regression: ok");

