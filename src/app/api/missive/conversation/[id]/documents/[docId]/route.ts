import { NextResponse, type NextRequest } from "next/server";
import { EmailDocumentError, fetchEmailDocument } from "@/lib/email-documents";
import { extractUuid } from "@/lib/missive-id";
import { isMissiveConfigured } from "@/lib/missive";

export const maxDuration = 60;

// Serves one document from the conversation, for the panel's previews and
// "Open" buttons. Missive's own download links expire after ~10 minutes, and
// linked files are fetched server-side, so both come through here. Only
// PDFs, images and plain text are shown inline; anything else downloads.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
  if (!isMissiveConfigured()) {
    return NextResponse.json({ error: "Missive is not configured (set MISSIVE_API_TOKEN)." }, { status: 501 });
  }
  const { id, docId } = await params;
  const conversationId = extractUuid(id);
  if (!conversationId) {
    return NextResponse.json({ error: "Missive conversation id did not contain a UUID." }, { status: 400 });
  }

  try {
    const doc = await fetchEmailDocument(conversationId, decodeURIComponent(docId));
    const inline = doc.kind !== "other";
    const asciiName = doc.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(new Uint8Array(doc.bytes), {
      headers: {
        "Content-Type": doc.contentType,
        "Content-Length": String(doc.bytes.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
        // PDFs keep the viewer working (same policy Missive serves them with);
        // everything else is sandboxed with no scripts.
        "Content-Security-Policy":
          doc.kind === "pdf"
            ? "script-src 'none'; object-src 'self'; base-uri 'none'; form-action 'none'"
            : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  } catch (error) {
    const status = error instanceof EmailDocumentError ? error.status : 502;
    if (status >= 500) console.error("Failed to fetch email document:", error);
    const message = error instanceof Error ? error.message : "Couldn't open this document.";
    return NextResponse.json({ error: message }, { status });
  }
}
