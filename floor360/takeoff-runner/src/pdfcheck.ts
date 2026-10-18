// Preflight on an uploaded file before the engine opens it: it must be a PDF,
// and it must not be encrypted. An owner-password PDF opens in pdf.js, but its
// pages cannot be vector-copied into the marked set, so it fails up front
// with the file named instead of half-way through the run.
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function hasPdfHeader(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // the spec allows junk before the header within the first 1024 bytes
    return buf.subarray(0, bytesRead).includes("%PDF-");
  } finally {
    await fh.close();
  }
}

// "/Encrypt" as a whole name (not "/EncryptMetadata"): it can only appear in a
// trailer or xref-stream dictionary, both of which are never compressed.
const ENCRYPT = /\/Encrypt(?![A-Za-z0-9])/;

export async function isEncryptedPdf(file: string): Promise<boolean> {
  let tail = "";
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const text = tail + (chunk as Buffer).toString("latin1");
    if (ENCRYPT.test(text)) return true;
    tail = text.slice(-16);
  }
  return false;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest("hex");
}
