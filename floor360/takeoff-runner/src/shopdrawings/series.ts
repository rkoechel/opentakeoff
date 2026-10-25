// Which source sheets get which series. A seam sheet needs a roll width.
// A pattern sheet needs a tile size. Transitions and base are drawn for every
// sheet that has rooms; a missing type is labeled, not invented.
import type { ShopModel } from "./model.ts";
import type { SheetGroups } from "./numbering.ts";

export function sheetGroups(model: ShopModel): SheetGroups {
  const ids = model.sheets.map((s) => s.id);
  return {
    finish: ids,
    roll: model.sheets.filter((s) => s.rooms.some((r) => r.kind === "roll" && (r.rollWidthFt ?? 0) > 0)).map((s) => s.id),
    pattern: model.sheets.filter((s) => s.rooms.some((r) => r.kind === "tile" && (r.tileWidthIn ?? 0) > 0 && (r.tileHeightIn ?? 0) > 0)).map((s) => s.id),
    transitions: ids,
  };
}
