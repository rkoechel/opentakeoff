// Confirms a detected scale against the title-block text (OpenTakeoff AGENT_GUIDE: check every scale against the title block).
/**
 * Replaces curly double quotes and the double-prime with a straight double quote, curly single quotes and the prime with a straight single quote, removes all whitespace, and uppercases.
 * @param {string} s - The input string to be canonized.
 * @returns {string} The canonized string.
 */
export function canonScale(s: string): string {
  return s
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/**
 * A non-global regex matching an architectural or engineering scale note in canon form such as 1/8"=1' or 1"=20' or a ratio like 1:48.
 * @type {RegExp}
 */
export const SCALE_NOTE_RE = /\d+(?:-\d+)?(?:\/\d+)?"=\d+'|(?<![\d:])1:\d+(?![\d:])/;

/**
 * Checks if the detected scale agrees with the title text.
 * @param {string} detected - The detected scale.
 * @param {string} titleText - The title text to check against.
 * @returns {"agrees" | "differs" | "absent"} Whether the detected scale agrees, differs, or is absent from the title text.
 */
export function titleBlockCheck(detected: string, titleText: string): "agrees" | "differs" | "absent" {
  const canonDetected = canonScale(detected);
  const canonTitleText = canonScale(titleText);
  const frac = canonDetected.match(/^(\d+)\/(\d+)"=1'/);
  const ratio = canonTitleText.match(/(?<![\d:])1:(\d+)(?![\d:])/);
  if (canonTitleText.includes(canonDetected) || canonTitleText.includes(canonDetected.replace(/-0"/g, '')) || (frac !== null && ratio !== null && (12 * Number(frac[2])) / Number(frac[1]) === Number(ratio[1]))) {
    return "agrees";
  } else if (SCALE_NOTE_RE.test(canonTitleText)) {
    return "differs";
  } else {
    return "absent";
  }
}

/**
 * Where the vision model looks for a scale note, in order: the whole right edge (title block and its notes), then the bottom strip (notes under each drawing title).
 */
export function scaleCrops(info: { width_px: number; height_px: number }): { x0: number; y0: number; x1: number; y1: number }[] {
  return [
    { x0: Math.round(info.width_px * 0.55), y0: 0, x1: info.width_px, y1: info.height_px },
    { x0: 0, y0: Math.round(info.height_px * 0.85), x1: info.width_px, y1: info.height_px }
  ];
}
