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
