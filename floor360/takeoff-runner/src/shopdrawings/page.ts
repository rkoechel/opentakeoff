// ANSI B landscape (11×17 in), the only sheet size shop drawings plot on.
import { RENDER_SCALE } from "../../../../web/src/lib/takeoffConstants.ts";

export const PAGE_W = 17 * 72;
export const PAGE_H = 11 * 72;
export const MARGIN = 16;
export const TITLE_H = 108;
export const LEGEND_W = 168;

export interface Box { x: number; y: number; w: number; h: number }

/** The band above the title block. */
export function drawingFrame(): Box {
  return {
    x: MARGIN,
    y: MARGIN + TITLE_H,
    w: PAGE_W - 2 * MARGIN,
    h: PAGE_H - 2 * MARGIN - TITLE_H,
  };
}

/** Plan area with the legend column held back on the right. */
export function planFrame(): Box {
  const d = drawingFrame();
  return { x: d.x, y: d.y, w: d.w - LEGEND_W - 8, h: d.h };
}

export function legendFrame(): Box {
  const d = drawingFrame();
  return { x: d.x + d.w - LEGEND_W, y: d.y, w: LEGEND_W, h: d.h };
}

export interface Fit extends Box { scale: number }

/** Uniform fit of an image-pixel sheet into a PDF box. `scale` is points per px. */
export function fitSheet(frame: Box, widthPx: number, heightPx: number): Fit {
  const scale = Math.min(frame.w / widthPx, frame.h / heightPx);
  const w = widthPx * scale;
  const h = heightPx * scale;
  return {
    x: frame.x + (frame.w - w) / 2,
    y: frame.y + (frame.h - h) / 2,
    w, h, scale,
  };
}

export interface Xy { x: number; y: number }

/** Image px (origin top-left, y down) → PDF user space (y up). */
export function pxToPdf(fit: Fit, px: number, py: number, heightPx: number): Xy {
  return { x: fit.x + px * fit.scale, y: fit.y + (heightPx - py) * fit.scale };
}

/** PDF points of a source page → image px, the frame verts_norm is stored against. */
export function pageSizeToPx(widthPt: number, heightPt: number): { widthPx: number; heightPx: number } {
  return { widthPx: widthPt * RENDER_SCALE, heightPx: heightPt * RENDER_SCALE };
}
