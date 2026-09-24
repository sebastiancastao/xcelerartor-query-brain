import { NextResponse } from "next/server";
import { draftReplyFromOrder } from "@/lib/agent";
import type { OrderInquiry } from "@/lib/xcelerator";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const order = body?.order as OrderInquiry | undefined;
  if (!order || typeof order.referenceNumber !== "string") {
    return NextResponse.json({ error: "order is required" }, { status: 400 });
  }

  try {
    return NextResponse.json({ reply: await draftReplyFromOrder(order) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to draft reply";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
