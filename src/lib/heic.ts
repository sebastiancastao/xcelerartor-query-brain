// HEIC/HEIF photos (what iPhones take by default) turned into JPEG, which
// Xcelerator, browsers and OpenAI all read. Server-only.

import { createHash } from "node:crypto";
import convert from "heic-convert";

/** ISO-BMFF brands HEIC/HEIF files carry in their "ftyp" box. AVIF ("avif", "avis") is left out. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "heif"]);

/** Whether the bytes are a HEIC/HEIF image, from the file's own header rather than its name. */
export function isHeic(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("latin1") !== "ftyp") return false;
  const major = bytes.subarray(8, 12).toString("latin1");
  if (major === "avif" || major === "avis") return false;
  if (HEIF_BRANDS.has(major)) return true;
  // Some files put a generic major brand first and "heic" among the compatible ones.
  const boxSize = Math.min(bytes.readUInt32BE(0), bytes.length, 64);
  for (let i = 16; i + 4 <= boxSize; i += 4) {
    const brand = bytes.subarray(i, i + 4).toString("latin1");
    if (brand === "heic" || brand === "heix") return true;
  }
  return false;
}

/** "IMG_1234.HEIC" -> "IMG_1234.jpg"; a name without the extension just gets ".jpg". */
export function jpegName(name: string): string {
  const base = name.replace(/\.(heic|heif|hif)$/i, "");
  return /\.jpe?g$/i.test(base) ? base : `${base}.jpg`;
}

const JPEG_QUALITY = 0.85;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 6;
// The panel summarizes a photo on open and attaches it later; the same photo
// is only decoded once in that window.
const converted = new Map<string, { jpeg: Buffer; expiresAt: number }>();

export class HeicConversionError extends Error {}

/** The photo as a JPEG. Decoding a 12 MP iPhone photo takes a few seconds. */
export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const key = createHash("sha256").update(bytes).digest("hex");
  const now = Date.now();
  for (const [k, v] of converted) if (v.expiresAt <= now) converted.delete(k);
  const hit = converted.get(key);
  if (hit) return hit.jpeg;

  let jpeg: Buffer;
  try {
    jpeg = Buffer.from(await convert({ buffer: new Uint8Array(bytes), format: "JPEG", quality: JPEG_QUALITY }));
  } catch (error) {
    console.error("HEIC to JPEG conversion failed:", error);
    throw new HeicConversionError("Couldn't convert this HEIC photo to JPG.");
  }
  while (converted.size >= CACHE_MAX) converted.delete(converted.keys().next().value as string);
  converted.set(key, { jpeg, expiresAt: now + CACHE_TTL_MS });
  return jpeg;
}
