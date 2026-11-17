// Prices a shipment on Quote Engine's ATL rate sheet, run in-process
// (src/lib/atl-rates.ts) rather than over the Quote Engine API, so no key or
// network call is needed. Read-only: nothing is saved and no order is created.

import { RateError, blankAtlPricing, calculateAtlRate } from "./atl-rates";
import {
  QUOTE_EXTRAS,
  easternWallClockToIso,
  type QuoteInputs,
  type QuoteResult,
} from "./quote-types";

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
