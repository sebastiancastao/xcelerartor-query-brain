import { NextResponse } from "next/server";
import type { InquiryEmail } from "@/lib/agent";
import { QuoteEngineError, calculateQuote } from "@/lib/quote-engine";
import { draftQuoteReply } from "@/lib/quote-request";
import { QUOTE_EXTRAS, TRIPS, VEHICLE_CLASSES, type QuoteInputs } from "@/lib/quote-types";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The quote inputs as the page sent them. The rate sheet checks ranges; this only checks the shape. */
function readInputs(value: unknown): QuoteInputs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!VEHICLE_CLASSES.includes(v.vehicleClass as QuoteInputs["vehicleClass"])) return null;
  if (!TRIPS.includes(v.trip as QuoteInputs["trip"])) return null;
  if (!finite(v.miles) || !finite(v.weight) || !finite(v.fuelPercent)) return null;
  if (v.fuelBasis !== "transport" && v.fuelBasis !== "subtotal") return null;
  if (typeof v.pickupStart !== "string" || typeof v.deliveryEnd !== "string") return null;
  return {
    vehicleClass: v.vehicleClass as QuoteInputs["vehicleClass"],
    miles: v.miles,
    weight: v.weight,
    vehicleCapacityLb: finite(v.vehicleCapacityLb) ? v.vehicleCapacityLb : null,
    pickupStart: v.pickupStart,
    deliveryEnd: v.deliveryEnd,
    fuelPercent: v.fuelPercent,
    fuelBasis: v.fuelBasis,
    trip: v.trip as QuoteInputs["trip"],
    extras: Array.isArray(v.extras) ? QUOTE_EXTRAS.filter((extra) => (v.extras as unknown[]).includes(extra)) : [],
    dryIcePounds: finite(v.dryIcePounds) ? v.dryIcePounds : 0,
  };
}

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
  const inputs = readInputs(body?.inputs);
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
