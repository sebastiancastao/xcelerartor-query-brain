import { NextResponse, type NextRequest } from "next/server";
import { EmailDocumentError, summarizeEmailDocument } from "@/lib/email-documents";
import { extractUuid } from "@/lib/missive-id";
import { isMissiveConfigured } from "@/lib/missive";

export const maxDuration = 90;

// Summarizes one document from the conversation with OpenAI. POST because
// each new summary costs a model call; repeats come from a one-day cache.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
  if (!isMissiveConfigured()) {
    return NextResponse.json({ error: "Missive is not configured (set MISSIVE_API_TOKEN)." }, { status: 501 });
  }
  const { id, docId } = await params;
  const conversationId = extractUuid(id);
  if (!conversationId) {
    return NextResponse.json({ error: "Missive conversation id did not contain a UUID." }, { status: 400 });
  }

  try {
    const summary = await summarizeEmailDocument(conversationId, decodeURIComponent(docId));
    return NextResponse.json({ summary });
  } catch (error) {
    const status = error instanceof EmailDocumentError ? error.status : 502;
    if (status >= 500) console.error("Failed to summarize email document:", error);
    const message = error instanceof Error ? error.message : "Couldn't summarize this document.";
    return NextResponse.json({ error: message }, { status });
  }
}
