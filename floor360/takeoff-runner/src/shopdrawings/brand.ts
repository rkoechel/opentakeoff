// Brandon Text and the FLOOR360 logo, committed under assets/brand.
// Resolved from the TypeScript sources (tsx) and from the esbuild bundle
// (dist/main.js) so the image and `npm test` load the same files.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function brandDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../assets/brand"),
    path.resolve(here, "../assets/brand"),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, "BrandonText-Regular.ttf")));
  if (!found) throw new Error("FLOOR360 brand assets are missing from the runner package.");
  return found;
}

export async function readBrandFile(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(brandDir(), name)));
}
