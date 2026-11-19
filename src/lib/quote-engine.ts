// Prices a shipment on Quote Engine's ATL rate sheet, run in-process
// (src/lib/atl-rates.ts) rather than over the Quote Engine API, so no key or
// network call is needed. Read-only: nothing is saved and no order is created.

import { RateError, blankAtlPricing, calculateAtlRate } from "./atl-rates";
import {
  QUOTE_EXTRAS,
  TRIPS,
  VEHICLE_CLASSES,
  easternWallClockToIso,
  type QuoteInputs,
  type QuoteResult,
} from "./quote-types";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Quote inputs as a page sent them, or null when malformed. The rate sheet checks ranges; this only checks the shape. */
export function readQuoteInputs(value: unknown): QuoteInputs | null {
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
    pickupWaitMinutes: finite(v.pickupWaitMinutes) ? v.pickupWaitMinutes : 0,
    deliveryWaitMinutes: finite(v.deliveryWaitMinutes) ? v.deliveryWaitMinutes : 0,
    additionalDeliveryAttempts: finite(v.additionalDeliveryAttempts) ? v.additionalDeliveryAttempts : 0,
    airportRecoveryAttempts: finite(v.airportRecoveryAttempts) ? v.airportRecoveryAttempts : 0,
    helperHours: finite(v.helperHours) ? v.helperHours : 0,
    helperHourlyRate: finite(v.helperHourlyRate) ? v.helperHourlyRate : null,
  };
}

/** A quote that could not be priced. `status` is the HTTP status to answer with. */
export class QuoteEngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Prices a shipment on the rate sheet. Read-only: no quote is saved and no order is created. */
export function calculateQuote(inputs: QuoteInputs): QuoteResult {
  const start = easternWallClockToIso(inputs.pickupStart);
  const end = easternWallClockToIso(inputs.deliveryEnd);
  if (!start || !end) throw new QuoteEngineError(400, "Set the pickup start and delivery end.");

  const extras = Object.fromEntries(QUOTE_EXTRAS.map((extra) => [extra, inputs.extras.includes(extra)]));
  const pricing = {
    ...blankAtlPricing(),
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
    pickupWaitMinutes: inputs.pickupWaitMinutes,
    deliveryWaitMinutes: inputs.deliveryWaitMinutes,
    additionalDeliveryAttempts: inputs.additionalDeliveryAttempts,
    airportRecoveryAttempts: inputs.airportRecoveryAttempts,
    helperHours: inputs.helperHours,
    helperHourlyRateCents: inputs.helperHourlyRate === null ? null : Math.round(inputs.helperHourlyRate * 100),
  };

  try {
    const { charges, snapshot } = calculateAtlRate(pricing, { weight: inputs.weight, start, end });
    return {
      totalCents: snapshot.totalCents,
      currency: "USD",
      charges: charges.map(({ description, quantity, rateCents }) => ({ description, quantity, rateCents })),
      warnings: snapshot.warnings,
    };
  } catch (err) {
    // The rate sheet's own rule messages ("Enter the actual vehicle cargo capacity…") go to the CSR as-is.
    if (err instanceof RateError) throw new QuoteEngineError(400, err.message);
    throw err;
  }
}
