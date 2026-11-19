import { NextResponse, type NextRequest } from "next/server";
import { fuelSurchargeDefaults } from "@/lib/fuel-defaults";
import { isSameOrigin } from "@/lib/same-origin";
import { currentFuelSurcharges, isXceleratorQuoteConfigured } from "@/lib/xcelerator-quote";

export const maxDuration = 60;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// The quote card's fuel surcharge: the current one Xcelerator keeps for each
// vehicle (the rate sheet says to ask for it), plus the default for each
// vehicle the card falls back on. Answers { fuel: null } when Xcelerator has
// none or isn't connected; `defaults` comes with every answer.
export async function POST(request: NextRequest) {
  const defaults = fuelSurchargeDefaults();
  if (!isXceleratorQuoteConfigured()) {
    return NextResponse.json({ fuel: null, defaults, reason: "Xcelerator's back office isn't connected" });
  }
  // Reading it reserves (and releases) an order number in Xcelerator, as opening Order Entry does.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Only allowed from this app's own page." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text(body?.day, 10))
    ? text(body?.day, 10)
    : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    const fuel = await currentFuelSurcharges(
      text(body?.senderEmail, 200),
      [text(body?.pickupAddress, 300) || null, text(body?.deliveryAddress, 300) || null],
      day,
    );
    return NextResponse.json({ fuel, defaults });
  } catch (err) {
    console.error("Fuel surcharge lookup failed:", err);
    return NextResponse.json(
      { error: "Couldn't read the fuel surcharge from Xcelerator.", defaults },
      { status: 502 },
    );
  }
}
