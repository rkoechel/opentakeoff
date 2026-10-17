// Hosts that must not appear in the FLOOR360 private artifact. The features
// that would call them are already off (OCR, Google/M365 sync, contribute,
// one-click). This pass deletes the leftover string literals from dependency
// chunks and static pages so a dist scan cannot mistake them for live calls.
//
// hf.co is the Hugging Face hub alias in transformers.js. accounts.google.com
// is the GIS script next to the googleapis.com userinfo URL. The PaddleOCR
// GitHub raw URL is the library's mirror for the same dead model download.

export const STRIPPED_HOSTS = [
  "cdn.jsdelivr.net",
  "huggingface.co",
  "hf.co",
  "googleapis.com",
  "graph.microsoft.com",
  "accounts.google.com",
  "opentakeoff.kentucky-ai.com",
];

const STRIPPED_URLS = [
  "https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models",
];

export function stripPrivateHosts(code) {
  let out = String(code);
  for (const url of STRIPPED_URLS) out = out.split(url).join("");
  for (const host of STRIPPED_HOSTS) out = out.split(host).join("");
  return out;
}
