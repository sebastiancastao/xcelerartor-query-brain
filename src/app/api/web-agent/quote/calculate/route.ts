import { NextResponse } from "next/server";
import type { InquiryEmail } from "@/lib/agent";
import { QuoteEngineError, calculateQuote, readQuoteInputs } from "@/lib/quote-engine";
import { draftQuoteReply } from "@/lib/quote-request";

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

function address(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}

/**
 * Prices the shipment on Quote Engine's rate sheet (in-process, no API call)
 * and drafts the reply that gives the customer that price. No quote is saved.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const inputs = readQuoteInputs(body?.inputs);
  if (!inputs) return NextResponse.json({ error: "Fill in the quote details first." }, { status: 400 });

  try {
    const quote = calculateQuote(inputs);
    const reply = await draftQuoteReply(readEmail(body?.email), quote, inputs, {
      pickupAddress: address(body?.route?.pickupAddress),
      deliveryAddress: address(body?.route?.deliveryAddress),
    });
    return NextResponse.json({ quote, reply });
  } catch (err) {
    if (err instanceof QuoteEngineError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 });
    }
    return NextResponse.json({ error: "Could not calculate the quote." }, { status: 502 });
  }
}
