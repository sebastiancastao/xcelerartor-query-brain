import { NextResponse } from "next/server";
import { draftReplyFromOrder, type InquiryEmail } from "@/lib/agent";
import type { OrderInquiry } from "@/lib/xcelerator";

/** The email the reply answers, when the page has one open in Missive; anything malformed is ignored. */
function readEmail(value: unknown): InquiryEmail | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (typeof e.body !== "string" || !e.body.trim()) return null;
  return {
    subject: typeof e.subject === "string" ? e.subject : "",
    from: typeof e.from === "string" ? e.from : "",
    fromName: typeof e.fromName === "string" ? e.fromName : undefined,
    body: e.body,
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const order = body?.order as OrderInquiry | undefined;
  if (!order || typeof order.referenceNumber !== "string") {
    return NextResponse.json({ error: "order is required" }, { status: 400 });
  }

  try {
    const { reply, asks } = await draftReplyFromOrder(order, readEmail(body?.email));
    return NextResponse.json({ reply, asks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to draft reply";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
