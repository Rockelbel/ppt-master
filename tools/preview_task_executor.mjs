/*
 * Translate a structured task into one minimal preview operation.
 * The executor intentionally does not know anything about PPT rendering;
 * that keeps queue safety independently testable from generation.
 */

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function pageNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function resolvePreviewIndex(taskSpec, pageCount, field = "targetPageNumber") {
  const number = pageNumber(taskSpec?.[field]);
  if (!number) throw fail("请明确要操作的预览页码");
  const index = number - 1;
  if (index < 0 || index >= pageCount) throw fail(`预览第 ${number} 页不存在`);
  return index;
}

export function buildPreviewTaskOperation(taskSpec, session, options = {}) {
  if (!taskSpec || taskSpec.mode !== "workflow") throw fail("当前请求不是 PPT 工作流");
  const before = Array.isArray(session?.pageIds) ? session.pageIds : [];
  const expectedVersion = options.expectedVersion ?? session?.version;
  const operation = taskSpec.operation;
  if (!["modify", "remove", "reorder"].includes(operation)) return null;
  if (!before.length) throw fail("当前预览没有页面");

  if (operation === "remove") {
    const index = resolvePreviewIndex(taskSpec, before.length);
    return { type: "remove_at", index, expectedPageId: before[index], expectedVersion };
  }

  if (operation === "reorder") {
    const fromIndex = resolvePreviewIndex(taskSpec, before.length, "reorderFromPageNumber");
    const toIndex = resolvePreviewIndex(taskSpec, before.length, "reorderToPageNumber");
    return { type: "reorder", fromIndex, toIndex, expectedPageId: before[fromIndex], expectedVersion };
  }

  const index = resolvePreviewIndex(taskSpec, before.length);
  return {
    type: "replace_at",
    index,
    expectedPageId: before[index],
    expectedVersion,
    targetPageId: before[index],
  };
}

export function previewDiff(before, after) {
  const left = Array.isArray(before) ? before : [];
  const right = Array.isArray(after) ? after : [];
  const changed = [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) changed.push({ index, before: left[index] || null, after: right[index] || null });
  }
  return { before: [...left], after: [...right], changed, added: right.filter(id => !left.includes(id)), removed: left.filter(id => !right.includes(id)) };
}

