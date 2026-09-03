import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentMapping } from "@/lib/documents";
import { mappingToAwbValues, fillAwbForm } from "@/lib/awb-fill";
import { ticketToIacValues, fillIacForm } from "@/lib/iac-fill";
import { mergePdfs, duplicatePage } from "@/lib/pdf-merge";

// pdf-lib needs the Node.js runtime.
export const runtime = "nodejs";

// Blank templates live in /public so they're bundled with the app.
const AWB_TEMPLATE_PATH = join(process.cwd(), "public", "awb-template.pdf");
const IAC_TEMPLATE_PATH = join(process.cwd(), "public", "iac-template.pdf");

// Return raw PDF bytes as a download response.
function pdfResponse(bytes: Uint8Array, filename: string): NextResponse {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST(req: NextRequest) {
  let mapping: DocumentMapping;
  let carrier: "southwest" | "delta" = "southwest";
  try {
    const body = await req.json();
    mapping = body.mapping;
    // Carrier chosen in the UI selects the output: Southwest → Air Waybill +
    // IAC packet; Delta → IAC certification only.
    if (body.carrier === "delta") carrier = "delta";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const iacValues = mapping ? ticketToIacValues(mapping, carrier) : null;

  try {
    // Delta: fill the IAC certification only (no Air Waybill).
    if (carrier === "delta") {
      if (!iacValues) {
        return NextResponse.json(
          { error: "The Delta workflow requires a DHL SameDay ticket." },
          { status: 400 },
        );
      }
      const iacTemplate = new Uint8Array(await readFile(IAC_TEMPLATE_PATH));
      const iac = await fillIacForm(iacTemplate, iacValues);
      return pdfResponse(iac.bytes, "DHL_IAC_filled.pdf");
    }

    // Southwest: fill the Air Waybill, and merge the IAC in for a ticket.
    const awbValues = mapping ? mappingToAwbValues(mapping) : null;
    if (!awbValues) {
      return NextResponse.json(
        {
          error:
            "Filling is only supported for DHL IAC and DHL SameDay ticket documents.",
        },
        { status: 400 },
      );
    }

    const awbTemplate = new Uint8Array(await readFile(AWB_TEMPLATE_PATH));
    const awb = await fillAwbForm(awbTemplate, awbValues);
    const parts: Uint8Array[] = [awb.bytes];

    if (iacValues) {
      const iacTemplate = new Uint8Array(await readFile(IAC_TEMPLATE_PATH));
      const iac = await fillIacForm(iacTemplate, iacValues);
      parts.push(iac.bytes);
    }

    const merged = parts.length > 1 ? await mergePdfs(parts) : awb.bytes;
    // The Southwest packet repeats its second page (the IAC certification), so
    // the output is Air Waybill + IAC + IAC. A single-page packet (no IAC) has
    // no second page and passes through untouched.
    const finalPdf = await duplicatePage(merged, 1);
    return pdfResponse(finalPdf, "Documents_filled.pdf");
  } catch (err) {
    console.error("Document fill failed:", err);
    return NextResponse.json(
      { error: "Failed to generate the filled documents." },
      { status: 500 },
    );
  }
}
