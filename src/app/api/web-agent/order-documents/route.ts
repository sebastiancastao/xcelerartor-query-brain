import { NextResponse, type NextRequest } from "next/server";
import { listOrderDocuments, OrderDocumentError } from "@/lib/order-documents";

export const maxDuration = 30;

// The documents already attached to an Xcelerator order, read through the
// ClientPortal login that found it. The documents panel on /web-agent uses
// it to warn before attaching a file that looks like one already there.
export async function GET(request: NextRequest) {
  const orderTrackingId = request.nextUrl.searchParams.get("orderTrackingId") ?? "";
  const caller = request.nextUrl.searchParams.get("caller") ?? "";
  if (!orderTrackingId || !caller) {
    return NextResponse.json({ error: "orderTrackingId and caller are required." }, { status: 400 });
  }
  try {
    return NextResponse.json({ documents: await listOrderDocuments(caller, orderTrackingId) });
  } catch (error) {
    const status = error instanceof OrderDocumentError ? error.status : 502;
    if (status >= 500) console.error("Failed to list order documents:", error);
    const message = error instanceof Error ? error.message : "Couldn't list the order's documents.";
    return NextResponse.json({ error: message }, { status });
  }
}
