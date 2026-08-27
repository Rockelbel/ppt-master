const MAX_PAGES = 200;
const MAX_LOG_ENTRIES = 100;

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizePreviewPageIds(value) {
  if (!Array.isArray(value)) throw badRequest("pageIds 必须是数组");
  if (value.length > MAX_PAGES) throw badRequest(`预览队列最多 ${MAX_PAGES} 页`);
  return value.map((id, index) => {
    if (typeof id !== "string" || !id.trim()) throw badRequest(`第 ${index + 1} 个页面 ID 无效`);
    return id.trim().slice(0, 160);
  });
}

export function createPreviewSession(id, pageIds = []) {
  const now = new Date().toISOString();
  return {
    id,
    pageIds: normalizePreviewPageIds(pageIds),
    version: 0,
    operationLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyPreviewOperation(session, operation, meta = {}) {
  if (!operation || typeof operation !== "object") throw badRequest("缺少预览队列操作");
  if (meta.expectedVersion !== undefined && Number(meta.expectedVersion) !== session.version) {
    const error = badRequest(`预览队列版本冲突：当前为 ${session.version}`, 409);
    error.currentSession = session;
    throw error;
  }
  const type = String(operation.type || "");
  const before = [...session.pageIds];
  let next = [...before];
  if (type === "append") {
    next.push(...normalizePreviewPageIds(operation.pageIds));
    if (next.length > MAX_PAGES) throw badRequest(`预览队列最多 ${MAX_PAGES} 页`);
  } else if (type === "replace_at") {
    const index = Number(operation.index);
    const pageIds = normalizePreviewPageIds(operation.pageIds ?? [operation.pageId]);
    if (!Number.isInteger(index) || index < 0 || index >= before.length) throw badRequest("替换位置超出当前预览队列");
    if (pageIds.length !== 1) throw badRequest("replace_at 必须且只能提供一个页面");
    if (operation.expectedPageId && before[index] !== operation.expectedPageId) throw badRequest("目标页面已变化，请刷新后重试", 409);
    next[index] = pageIds[0];
  } else if (type === "remove_at") {
    const index = Number(operation.index);
    if (!Number.isInteger(index) || index < 0 || index >= before.length) throw badRequest("删除位置超出当前预览队列");
    if (operation.expectedPageId && before[index] !== operation.expectedPageId) throw badRequest("目标页面已变化，请刷新后重试", 409);
    next.splice(index, 1);
  } else if (type === "reorder") {
    const fromIndex = Number(operation.fromIndex);
    const toIndex = Number(operation.toIndex);
    if (![fromIndex, toIndex].every(index => Number.isInteger(index) && index >= 0 && index < before.length)) throw badRequest("调序位置超出当前预览队列");
    if (operation.expectedPageId && before[fromIndex] !== operation.expectedPageId) throw badRequest("待移动页面已变化，请刷新后重试", 409);
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
  } else if (type === "replace_all") {
    next = normalizePreviewPageIds(operation.pageIds);
  } else {
    throw badRequest("不支持的预览队列操作");
  }

  session.pageIds = next;
  session.version += 1;
  session.updatedAt = new Date().toISOString();
  session.operationLog = [...(session.operationLog || []), {
    id: `preview-op-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    beforeVersion: session.version - 1,
    afterVersion: session.version,
    beforePageIds: before,
    afterPageIds: [...next],
    source: String(meta.source || "api").slice(0, 80),
    taskId: meta.taskId ? String(meta.taskId).slice(0, 160) : null,
    createdAt: session.updatedAt,
  }].slice(-MAX_LOG_ENTRIES);
  return session;
}
