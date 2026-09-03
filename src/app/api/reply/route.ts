import { NextResponse } from "next/server";
import { draftReplyForOrder } from "@/lib/agent";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const referenceNumber = body?.referenceNumber;

  if (typeof referenceNumber !== "string" || !referenceNumber.trim()) {
    return NextResponse.json({ error: "referenceNumber is required" }, { status: 400 });
  }

  try {
    const reply = await draftReplyForOrder(referenceNumber);
    return NextResponse.json({ reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to draft reply";
    const status = message.includes("not found") ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
