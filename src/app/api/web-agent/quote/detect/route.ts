import { NextResponse } from "next/server";
import type { InquiryEmail } from "@/lib/agent";
import { detectQuoteRequest } from "@/lib/quote-request";

/** Says whether the email open in Missive asks for a price quote, and what shipment details it gives. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const e = body?.email as Record<string, unknown> | undefined;
  if (!e || typeof e.body !== "string" || !e.body.trim()) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const email: InquiryEmail = {
    subject: typeof e.subject === "string" ? e.subject : "",
    from: typeof e.from === "string" ? e.from : "",
    fromName: typeof e.fromName === "string" ? e.fromName : undefined,
    body: e.body,
  };

  try {
    return NextResponse.json({ detection: await detectQuoteRequest(email) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read the email";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
