// Client for the Quote Engine API (plain fetch, server side only: the key
// grants access to every quote in that workspace, so it never reaches the
// browser). Only the two read-only rate endpoints are used: nothing here
// saves a quote or creates an order.

import {
  QUOTE_EXTRAS,
  easternWallClockToIso,
  type QuoteCharge,
  type QuoteInputs,
  type QuoteResult,
} from "./quote-types";

const DEFAULT_BASE_URL = "https://quote-engine-theta.vercel.app/api/v1";
const TIMEOUT_MS = 15000;
/** Quote Engine rejects keys shorter than this, so a shorter one here is a typo. */
const MIN_KEY_LENGTH = 32;

function apiKey(): string {
  return process.env.QUOTE_API_KEY?.trim() ?? "";
}

export function isQuoteEngineConfigured(): boolean {
  return apiKey().length >= MIN_KEY_LENGTH;
}

/** A failed Quote Engine call. `status` is its HTTP status, or 502 when it could not be reached. */
export class QuoteEngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  if (!isQuoteEngineConfigured()) {
    throw new QuoteEngineError(501, "Quote Engine isn't connected yet (set QUOTE_API_KEY).");
  }
  const base = (process.env.QUOTE_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuoteEngineError(502, "Quote Engine did not answer. Try again.");
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
    if (response.status === 401) throw new QuoteEngineError(401, "Quote Engine rejected QUOTE_API_KEY.");
    throw new QuoteEngineError(response.status, detail);
  }
  if (!body) throw new QuoteEngineError(502, "Quote Engine sent an unreadable answer.");
  return body;
}

// The full pricing object changes only when Quote Engine is redeployed.
const DEFAULTS_TTL_MS = 10 * 60 * 1000;
let cachedDefaults: { at: number; value: Record<string, unknown> } | null = null;

async function pricingDefaults(): Promise<Record<string, unknown>> {
  if (cachedDefaults && Date.now() - cachedDefaults.at < DEFAULTS_TTL_MS) return cachedDefaults.value;
  const body = await api("/rates");
  const value = body.pricingDefaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QuoteEngineError(502, "Quote Engine sent no pricing defaults.");
  }
  cachedDefaults = { at: Date.now(), value: value as Record<string, unknown> };
  return cachedDefaults.value;
}

function readCharges(value: unknown): QuoteCharge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const c = item as Record<string, unknown> | null;
    if (!c || typeof c.description !== "string" || typeof c.quantity !== "number" || typeof c.rateCents !== "number") {
      return [];
    }
    return [{ description: c.description, quantity: c.quantity, rateCents: c.rateCents }];
  });
}

/** Prices a shipment on the rate sheet. Read-only: no quote is saved and no order is created. */
export async function calculateQuote(inputs: QuoteInputs): Promise<QuoteResult> {
  const start = easternWallClockToIso(inputs.pickupStart);
  const end = easternWallClockToIso(inputs.deliveryEnd);
  if (!start || !end) throw new QuoteEngineError(400, "Set the pickup start and delivery end.");

  const extras = Object.fromEntries(QUOTE_EXTRAS.map((extra) => [extra, inputs.extras.includes(extra)]));
  const pricing = {
    ...(await pricingDefaults()),
    ...extras,
    vehicleClass: inputs.vehicleClass,
    miles: inputs.miles,
    vehicleCapacityLb: inputs.vehicleCapacityLb,
    fuelPercent: inputs.fuelPercent,
    fuelBasis: inputs.fuelBasis,
    trip: inputs.trip,
    // The 150% round-trip rate only applies when freight rides both ways,
    // which is what the round-trip option on the quote card says.
    loadedBothWays: inputs.trip === "roundtrip",
    dryIcePounds: inputs.dryIcePounds,
  };

  const body = await api("/rates/calculate", {
    method: "POST",
    body: { pricing, shipment: { weight: inputs.weight, start, end } },
  });
  if (typeof body.totalCents !== "number") throw new QuoteEngineError(502, "Quote Engine sent no total.");
  const snapshot = body.snapshot as { warnings?: unknown } | undefined;
  return {
    totalCents: body.totalCents,
    currency: typeof body.currency === "string" ? body.currency : "USD",
    charges: readCharges(body.charges),
    warnings: Array.isArray(snapshot?.warnings)
      ? snapshot.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}
