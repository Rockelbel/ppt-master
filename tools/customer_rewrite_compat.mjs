const STATUS_MAP = new Map([
  ["pending", "queued"],
  ["running", "processing"],
  ["done", "completed"],
  ["success", "completed"],
]);
const STATUSES = new Set(["queued", "processing", "review", "completed", "failed"]);
const DELIVERY_STATUSES = new Set(["draft", "process", "deliverable"]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value) {
  const status = String(value || "queued").toLowerCase();
  const mapped = STATUS_MAP.get(status) || status;
  return STATUSES.has(mapped) ? mapped : "queued";
}

function normalizeDeliveryStatus(input, status, qualityGate) {
  if (DELIVERY_STATUSES.has(input.deliveryStatus)) return input.deliveryStatus;
  if (status === "completed") return qualityGate?.passed === true ? "deliverable" : "process";
  if (status === "review") return "process";
  return "draft";
}

// Read-time compatibility only. The caller decides when the normalized record
// is persisted; loading old records must not rewrite the task file.
export function normalizeCustomerRewriteTask(input = {}) {
  const now = new Date().toISOString();
  const qualityGate = input.qualityGate && typeof input.qualityGate === "object"
    ? input.qualityGate
    : input.quality && typeof input.quality === "object" ? input.quality : null;
  const status = normalizeStatus(input.status);
  const savedChangePlan = listOrEmpty(input.changePlan);
  const savedOutputPlan = listOrEmpty(input.outputPlan);
  const sourceChangePlan = savedChangePlan.some(item => item?.action === "create") && savedOutputPlan.length
    ? savedOutputPlan.filter(item => item?.action !== "create")
    : savedChangePlan;
  const normalized = {
    ...input,
    id: String(input.id || ""),
    name: String(input.name || "未命名 PPT").slice(0, 255),
    sourceCustomer: String(input.sourceCustomer || "").slice(0, 80),
    sourceCustomerDetected: Boolean(input.sourceCustomerDetected),
    targetCustomer: String(input.targetCustomer || "").slice(0, 80),
    status,
    progress: Math.min(100, Math.max(0, Number(input.progress) || 0)),
    stage: String(input.stage || "queued"),
    message: input.message ? String(input.message).slice(0, 1000) : "等待客户化改写处理",
    metrics: {
      processedPages: numberOrNull(input.metrics?.processedPages),
      replacedPages: numberOrNull(input.metrics?.replacedPages),
      retainedPages: numberOrNull(input.metrics?.retainedPages),
      pendingPages: numberOrNull(input.metrics?.pendingPages),
      failedPages: numberOrNull(input.metrics?.failedPages),
    },
    changePlan: sourceChangePlan,
    pagePreviews: listOrEmpty(input.pagePreviews),
    missingInputs: listOrEmpty(input.missingInputs),
    evidence: listOrEmpty(input.evidence),
    materialEvidence: input.materialEvidence && typeof input.materialEvidence === "object" ? input.materialEvidence : null,
    materialExtraction: input.materialExtraction && typeof input.materialExtraction === "object" ? input.materialExtraction : null,
    gapPagePlan: input.gapPagePlan && typeof input.gapPagePlan === "object" ? input.gapPagePlan : null,
    generatedGapPages: listOrEmpty(input.generatedGapPages),
    outputPlan: savedOutputPlan,
    residuals: listOrEmpty(input.residuals),
    deliveryStatus: normalizeDeliveryStatus(input, status, qualityGate),
    planConfirmed: Boolean(input.planConfirmed),
    planVersion: numberOrNull(input.planVersion) ?? 0,
    outputVersion: numberOrNull(input.outputVersion) ?? 0,
    operationLog: listOrEmpty(input.operationLog).slice(-100),
    qualityGate,
    // Keep the generic alias for older clients while the current UI uses
    // qualityGate.
    quality: qualityGate,
    sourcePath: input.sourcePath || null,
    source: input.source && typeof input.source === "object" ? input.source : null,
    targetLogoPath: input.targetLogoPath || null,
    targetLogoName: input.targetLogoName || null,
    materials: listOrEmpty(input.materials),
    outputPath: input.outputPath || null,
    previewPath: input.previewPath || null,
    qualityPath: input.qualityPath || null,
    previewUrl: input.previewUrl || null,
    qualityUrl: input.qualityUrl || null,
    exportUrl: input.exportUrl || null,
    createdAt: input.createdAt || now,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    updatedAt: input.updatedAt || now,
    error: input.error || null,
  };
  return normalized;
}
