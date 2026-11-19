import { NextResponse, type NextRequest } from "next/server";
import { RouteMilesError } from "@/lib/google-maps";
import { QuoteEngineError, calculateQuote, readQuoteInputs } from "@/lib/quote-engine";
import { isSameOrigin } from "@/lib/same-origin";
import {
  XceleratorQuoteError,
  isXceleratorQuoteConfigured,
  previewXceleratorQuote,
  saveXceleratorQuote,
  suggestXceleratorAccount,
  type QuoteForXcelerator,
} from "@/lib/xcelerator-quote";

export const maxDuration = 60;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

// The quote card's link to Xcelerator:
//  - "suggest": the sender's account, when the email domain points at one, and other likely accounts.
//  - "preview": everything the quote would be saved with (account, addresses, vehicle, charges), worked
//    out in Xcelerator without saving it.
//  - "save": saves it in Xcelerator as a quote ("Q..."). Only on a CSR's click, from this app's page.
// The price is always calculated here from the inputs, never taken from the page.
export async function POST(request: NextRequest) {
  if (!isXceleratorQuoteConfigured()) {
    return NextResponse.json(
      { error: "Xcelerator's back office isn't connected (set XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD), so quotes can't be saved there." },
      { status: 501 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;

  try {
    if (action === "suggest") {
      return NextResponse.json(
        await suggestXceleratorAccount(text(body?.senderEmail, 200), [
          text(body?.pickupAddress, 300) || null,
          text(body?.deliveryAddress, 300) || null,
        ]),
      );
    }
    if (action !== "preview" && action !== "save") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    // Both reserve an order number in Xcelerator, and save writes a quote there.
    if (!isSameOrigin(request)) {
      return NextResponse.json({ error: "Saving to Xcelerator is only allowed from this app's own page." }, { status: 403 });
    }
    const inputs = readQuoteInputs(body?.inputs);
    const accountNo = text(body?.accountNo, 20);
    const pickupAddress = text(body?.pickupAddress, 300);
    const deliveryAddress = text(body?.deliveryAddress, 300);
    if (!inputs || !accountNo || !pickupAddress || !deliveryAddress) {
      return NextResponse.json({ error: "Choose the account and fill in the pickup and delivery places first." }, { status: 400 });
    }
    const req: QuoteForXcelerator = {
      accountNo,
      inputs,
      quote: calculateQuote(inputs),
      pickupAddress,
      deliveryAddress,
      pieces: count(body?.pieces),
      pallets: count(body?.pallets),
      callerName: text(body?.callerName, 75),
    };
    if (action === "preview") return NextResponse.json({ plan: await previewXceleratorQuote(req) });
    return NextResponse.json({ saved: await saveXceleratorQuote(req) });
  } catch (err) {
    if (err instanceof XceleratorQuoteError || err instanceof RouteMilesError || err instanceof QuoteEngineError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 });
    }
    console.error("Xcelerator quote failed:", err);
    const message = err instanceof Error ? err.message : "Xcelerator didn't answer.";
    return NextResponse.json({ error: `Xcelerator didn't answer (${message}).` }, { status: 502 });
  }
}
