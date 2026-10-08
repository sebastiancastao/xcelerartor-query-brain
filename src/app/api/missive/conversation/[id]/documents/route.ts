import { NextResponse, type NextRequest } from "next/server";
import { EmailDocumentError, listEmailDocuments } from "@/lib/email-documents";
import { extractUuid } from "@/lib/missive-id";
import { isMissiveConfigured } from "@/lib/missive";
import { isOpenAIConfigured } from "@/lib/openai";

// Lists the attachments and document links in the Missive conversation a
// CSR has open, for the documents panel on /web-agent.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isMissiveConfigured()) {
    return NextResponse.json({ error: "Missive is not configured (set MISSIVE_API_TOKEN)." }, { status: 501 });
  }
  const conversationId = extractUuid((await params).id);
  if (!conversationId) {
    return NextResponse.json({ error: "Missive conversation id did not contain a UUID." }, { status: 400 });
  }

  try {
    const documents = await listEmailDocuments(conversationId);
    return NextResponse.json({ documents, summaries: isOpenAIConfigured() });
  } catch (error) {
    console.error("Failed to list email documents:", error);
    const status = error instanceof EmailDocumentError ? error.status : 502;
    const message = error instanceof Error ? error.message : "Couldn't read this email's documents.";
    return NextResponse.json({ error: message }, { status });
  }
}
