// Document watermark for MCP exports. Default off.
// "1" or "true" turns it on. The web build reads VITE_OT_WATERMARK
// (web/src/lib/branding.js); this process reads OT_WATERMARK. stampWatermark,
// which export_marked_pdf reaches through web/src/lib/markedset.js, honors both.

/** @returns true only for the exact strings "1" and "true". */
export function watermarkEnabled(): boolean {
  const v = process.env.OT_WATERMARK;
  return v === "1" || v === "true";
}
