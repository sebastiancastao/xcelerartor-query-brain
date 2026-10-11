import { NextResponse, type NextRequest } from "next/server";
import { EmailDocumentError, fetchEmailDocument } from "@/lib/email-documents";
import { isMissiveConfigured } from "@/lib/missive";
import { extractUuid } from "@/lib/missive-id";
import { attachDocumentToOrder, ORDER_DOCUMENT_TYPES, OrderDocumentError } from "@/lib/order-documents";
import { isSameOrigin } from "@/lib/same-origin";

export const maxDuration = 90;

// Attaches one document from the open Missive email to an Xcelerator order,
// through the ClientPortal login that found the order. A CSR starts it with
// the panel's "Attach to order" button; nothing is attached automatically.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Attaching is only allowed from this app's own page." }, { status: 403 });
  }
  if (!isMissiveConfigured()) {
    return NextResponse.json({ error: "Missive is not configured (set MISSIVE_API_TOKEN)." }, { status: 501 });
  }
  const { id, docId } = await params;
  const conversationId = extractUuid(id);
  if (!conversationId) {
    return NextResponse.json({ error: "Missive conversation id did not contain a UUID." }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { orderTrackingId?: unknown; caller?: unknown } | null;
  const orderTrackingId = typeof body?.orderTrackingId === "string" ? body.orderTrackingId : "";
  const caller = typeof body?.caller === "string" ? body.caller : "";
  if (!orderTrackingId || !caller) {
    return NextResponse.json({ error: "orderTrackingId and caller are required." }, { status: 400 });
  }

  try {
    const doc = await fetchEmailDocument(conversationId, decodeURIComponent(docId));
    // BMP is accepted by the portal but not sniffed as an image elsewhere.
    const isBmp = doc.bytes.subarray(0, 2).toString("latin1") === "BM" && /\.bmp$/i.test(doc.name);
    const contentType = isBmp ? "image/bmp" : doc.contentType;
    const ext = ORDER_DOCUMENT_TYPES[contentType.split(";")[0]];
    const fileName = ext && !/\.[a-z0-9]{2,5}$/i.test(doc.name) ? `${doc.name}.${ext}` : doc.name;

    const result = await attachDocumentToOrder({ callerLabel: caller, orderTrackingId, fileName, contentType, bytes: doc.bytes });
    console.info(
      `Attached email document "${fileName}" (${doc.bytes.length} bytes) from conversation ${conversationId} ` +
        `to order ${orderTrackingId} as ${caller}; new document id ${result.added?.id ?? "unknown"}`,
    );
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof EmailDocumentError || error instanceof OrderDocumentError ? error.status : 502;
    if (status >= 500) console.error("Failed to attach email document:", error);
    const message = error instanceof Error ? error.message : "Couldn't attach this document.";
    return NextResponse.json({ error: message }, { status });
  }
}
