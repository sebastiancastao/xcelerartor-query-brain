// Merge several PDFs into one. Used to combine the filled Air Waybill and the
// filled DHL IAC certification into a single downloadable packet.
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

/**
 * Concatenate the given PDFs (in order) into one document and return its bytes.
 * Each source's form fields are flattened first, so filled Air Waybill values
 * are baked into the page content and render correctly once copied.
 */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    // Flatten any AcroForm so field appearances become static content. A scan
    // with no form (the IAC) has nothing to flatten, so this is a no-op there.
    try {
      src.getForm().flatten();
    } catch {
      // No form / nothing to flatten — fine.
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}

/**
 * Return a copy of `bytes` with the page at `index` duplicated in place — the
 * copy is inserted immediately after the original. Used to repeat the second
 * page (the IAC certification) of the Southwest packet. A no-op when `index`
 * is out of range, so single-page packets pass through unchanged.
 */
export async function duplicatePage(
  bytes: Uint8Array,
  index: number,
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  if (index < 0 || index >= doc.getPageCount()) return bytes;
  const [copy] = await doc.copyPages(doc, [index]);
  doc.insertPage(index + 1, copy);
  return doc.save();
}
