// Sheet numbers Ryan set: SD-000 cover, SD-101 finish, SD-201 seam/roll,
// SD-301 pattern, SD-401 transitions and base. Each series holds 99 sheets.
import { compareSheetKeys } from "../../../../web/src/lib/sheetKey.ts";

export type SheetSeries = "cover" | "finish" | "roll" | "pattern" | "transitions";

export interface SheetSpec {
  number: string;
  /** 1-based position in the set. */
  page: number;
  pages: number;
  series: SheetSeries;
  title: string;
  sourceSheetId?: string;
}

const SERIES_BASE: Record<Exclude<SheetSeries, "cover">, number> = {
  finish: 100,
  roll: 200,
  pattern: 300,
  transitions: 400,
};

export function sheetNumber(series: SheetSeries, index: number): string {
  if (series === "cover") return "SD-000";
  if (index < 1 || index > 99) throw new Error(`Sheet series ${series} has no number for index ${index}.`);
  return `SD-${String(SERIES_BASE[series] + index).padStart(3, "0")}`;
}

export interface SheetGroups {
  finish: string[];
  roll?: string[];
  pattern?: string[];
  transitions?: string[];
}

const TITLES: Record<SheetSeries, string> = {
  cover: "Cover / index",
  finish: "Finish plan",
  roll: "Seam / roll plan",
  pattern: "Pattern plan",
  transitions: "Transitions and base",
};

/** Cover first, then each series in source-sheet order. */
export function planSheets(groups: SheetGroups): SheetSpec[] {
  const rows: { series: SheetSeries; title: string; sourceSheetId?: string }[] = [
    { series: "cover", title: TITLES.cover },
  ];
  const push = (series: Exclude<SheetSeries, "cover">, ids: string[] | undefined) => {
    const sorted = [...(ids ?? [])].sort(compareSheetKeys);
    for (const id of sorted) rows.push({ series, title: TITLES[series], sourceSheetId: id });
  };
  push("finish", groups.finish);
  push("roll", groups.roll);
  push("pattern", groups.pattern);
  push("transitions", groups.transitions);
  const counts = new Map<SheetSeries, number>();
  return rows.map((row, i) => {
    const n = (counts.get(row.series) ?? 0) + 1;
    counts.set(row.series, n);
    return {
      ...row,
      number: sheetNumber(row.series, row.series === "cover" ? 0 : n),
      page: i + 1,
      pages: rows.length,
    };
  });
}
