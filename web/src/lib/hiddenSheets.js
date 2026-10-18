// FLOOR360: sheets the estimator hid from the plan set (persisted as the additive hidden_sheets key). Hiding never touches the PDF; it only filters the gallery, search and tabs, and is undoable.

export function sanitizeHiddenSheets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.filter((s) => {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    if (!trimmed) return false;
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export function isHidden(hidden, key) {
  return Array.isArray(hidden) && hidden.includes(key);
}

export function toggleHidden(hidden, key) {
  const list = sanitizeHiddenSheets(hidden);
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

export function visibleKeys(keys, hidden, showHidden) {
  if (showHidden) return keys;
  return keys.filter((k) => !isHidden(hidden, k));
}

export function hiddenCount(keys, hidden) {
  return keys.filter((k) => isHidden(hidden, k)).length;
}

export function canHide(shapeCount) {
  return !(shapeCount > 0);
}

/**
 * Returns true if the given object is a non-null object with a non-empty "kind" string and a string "message".
 * @param {any} f - The object to check.
 * @returns {boolean} True if the object is a valid finding, false otherwise.
 */
export function isFinding(f) {
  return f !== null && typeof f === "object" && !Array.isArray(f) && typeof f.kind === "string" && f.kind !== "" && typeof f.message === "string";
}

/**
 * Filters the given findings array to only include items that are valid findings.
 * If showHidden is truthy, all valid findings are returned. Otherwise, items with a hidden sheet are dropped.
 * @param {unknown} findings - The array of findings to filter.
 * @param {unknown} hidden - The hidden items to consider.
 * @param {unknown} showHidden - Whether to show hidden items.
 * @returns {any[]} The filtered array of findings.
 */
export function visibleFindings(findings, hidden, showHidden) {
  if (!Array.isArray(findings)) return [];
  return findings.filter(f => isFinding(f)).filter(f => showHidden || !f.sheet || !isHidden(hidden, f.sheet));
}

/**
 * Returns the number of hidden findings in the given array.
 * @param {unknown} findings - The array of findings to count.
 * @param {unknown} hidden - The hidden items to consider.
 * @returns {number} The number of hidden findings.
 */
export function hiddenFindingCount(findings, hidden) {
  if (!Array.isArray(findings)) return 0;
  return findings.filter(f => isFinding(f) && f.sheet && isHidden(hidden, f.sheet)).length;
}
