import { NextResponse, type NextRequest } from "next/server";
import { fuelAssignmentFor } from "@/lib/fuel-defaults";
import { isSameOrigin } from "@/lib/same-origin";

export const maxDuration = 60;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// The quote card's fuel surcharge, for a card whose reading came without one:
// the current one Xcelerator keeps for each vehicle (the rate sheet says to
// ask for it), plus the default for each vehicle the card falls back on.
// Answers { fuel: null } when Xcelerator has none or isn't connected, with
// `reason`; `defaults` comes with every answer.
export async function POST(request: NextRequest) {
  // Reading it reserves (and releases) an order number in Xcelerator, as opening Order Entry does.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Only allowed from this app's own page." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text(body?.day, 10)) ? text(body?.day, 10) : undefined;
  const assignment = await fuelAssignmentFor(
    text(body?.senderEmail, 200),
    [text(body?.pickupAddress, 300) || null, text(body?.deliveryAddress, 300) || null],
    day,
  );
  return NextResponse.json({
    fuel: assignment.xcelerator,
    defaults: assignment.defaults,
    reason: assignment.unavailable ?? undefined,
  });
}
