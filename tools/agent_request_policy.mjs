const TARGETED_PREVIEW_OPERATIONS = new Set(["modify", "remove", "reorder"]);

export function isTargetedPreviewOperation(taskSpec) {
  return Boolean(taskSpec && TARGETED_PREVIEW_OPERATIONS.has(taskSpec.operation));
}

export function needsPreviewContext(taskSpec) {
  return taskSpec?.operation === "modify";
}

export function shouldUseModelIntent(taskSpec) {
  return !isTargetedPreviewOperation(taskSpec);
}

export function shouldUseLiveKnowledge(taskSpec, mode) {
  return mode === "workflow" && !isTargetedPreviewOperation(taskSpec);
}

export function shouldUseExternalResearch(taskSpec, mode) {
  return !isTargetedPreviewOperation(taskSpec);
}
