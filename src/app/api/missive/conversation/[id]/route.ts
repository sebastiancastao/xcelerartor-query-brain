import { NextResponse, type NextRequest } from "next/server";
import { extractUuid } from "@/lib/missive-id";
import { fetchMissiveConversationText, isMissiveConfigured } from "@/lib/missive";

// Backs the "sense the open Missive email" panel on the home page: given the
// conversation id Missive's iframe SDK reports as currently selected, this
// returns just enough text (subject + body) for the client to run through
// detectOrderReferences() and pre-fill the search box. It never returns a
// reference number itself and never triggers a lookup — that stays entirely
// client-side and editable.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isMissiveConfigured()) {
    return NextResponse.json(
      { error: "Missive is not configured (set MISSIVE_API_TOKEN in .env.local)." },
      { status: 501 }
    );
  }

  const { id } = await params;
  const conversationId = extractUuid(id);
  if (!conversationId) {
    return NextResponse.json(
      { error: "Missive conversation id did not contain a UUID." },
      { status: 400 }
    );
  }

  try {
    const email = await fetchMissiveConversationText(conversationId);
    return NextResponse.json({ email });
  } catch (error) {
    console.error("Failed to fetch Missive conversation:", error);
    const message = error instanceof Error ? error.message : "Failed to fetch Missive conversation.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
