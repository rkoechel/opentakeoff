// Which source sheets get which series. PR1 draws the cover and finish plans.
// Later series (seam, pattern, transitions) add their sheet ids here.
import type { ShopModel } from "./model.ts";
import type { SheetGroups } from "./numbering.ts";

export function sheetGroups(model: ShopModel): SheetGroups {
  return { finish: model.sheets.map((s) => s.id) };
}
