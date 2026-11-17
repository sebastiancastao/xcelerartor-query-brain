// The ATL medical-courier rate sheet, copied from Quote Engine
// (quote-engine/src/lib/atl-rates.ts) so /web-agent prices quotes in-process
// instead of calling the Quote Engine API. Keep the two copies in sync when
// the rate sheet changes: the pricing rules here are Quote Engine's, unedited.

/** One line on a quote. */
export interface Charge {
  description: string;
  quantity: number;
  rateCents: number;
}

export const ATL_SHEET = {
  id: "atl-medical-2026-v1" as const,
  title: "ATL ASAP Rates Medical Couriers — 2026",
  source: "ATL Rates 2026 Medical Couriers (1).pdf",
  sha256: "c2b0eadd8620635dfa431caeebacb71a4fb874486ef64f812efbce4613f14384",
  timeZone: "America/New_York",
  dryIceRateCents: 325,
  dryIcePriceDate: "2026-09-25",
};

export const ATL_VEHICLES = {
  "small-package": {
    label: "Small package / passenger vehicle",
    minimum: 3800,
    perMile: 160,
    includedMiles: 0,
    freeWait: 15,
    perWaitMinute: 49,
    freeWeight: 100,
    perPound: 6,
    afterHours: 2000,
    weekend: 2000,
    holiday: 5000,
  },
  "cargo-van": {
    label: "Cargo van",
    minimum: 5900,
    perMile: 179,
    includedMiles: 20,
    freeWait: 15,
    perWaitMinute: 49,
    freeWeight: 100,
    perPound: 6,
    afterHours: 2000,
    weekend: 2000,
    holiday: 5000,
  },
  "cube-sprinter": {
    label: "Cube van / Sprinter",
    minimum: 9950,
    perMile: 205,
    includedMiles: 20,
    freeWait: 15,
    perWaitMinute: 50,
    freeWeight: 100,
    perPound: 6,
    afterHours: 2000,
    weekend: 2000,
    holiday: 5000,
  },
  "box-truck": {
    label: "Straight truck / box truck",
    minimum: 25000,
    perMile: 325,
    includedMiles: 20,
    freeWait: 60,
    perWaitMinute: 90,
    freeWeight: 2000,
    perPound: 4,
    afterHours: 5000,
    weekend: 7500,
    holiday: 10000,
  },
} as const;
export type AtlVehicleClass = keyof typeof ATL_VEHICLES;
export type MileageBasis = "included-20";
export type FuelBasis = "transport" | "subtotal";

export interface AtlPricingInput {
  sheetId: typeof ATL_SHEET.id;
  vehicleClass: AtlVehicleClass;
  mileageBasis: MileageBasis | null;
  miles: number | null;
  vehicleCapacityLb: number | null;
  pickupWaitMinutes: number;
  deliveryWaitMinutes: number;
  trip: "one-way" | "roundtrip" | "return";
  loadedBothWays: boolean;
  fuelPercent: number | null;
  fuelBasis: FuelBasis | null;
  secondAirlineCounter: boolean;
  airportRecoveryAttempts: number;
  additionalDeliveryAttempts: number;
  paperworkFaxed: boolean;
  dryIcePickup: boolean;
  dryIcePounds: number;
  hazmat: boolean;
  holdOver: boolean;
  dryIceReplenish: boolean;
  liftGate: boolean;
  palletJack: boolean;
  helperHours: number;
  helperHourlyRateCents: number | null;
}

export interface RateShipment {
  weight: number;
  start: string;
  end: string;
}
export interface AtlRateSnapshot {
  sheetId: typeof ATL_SHEET.id;
  sourceSha256: string;
  vehicleClass: AtlVehicleClass;
  timeZone: string;
  oneWayBaseCents: number;
  transportCents: number;
  billablePickupWait: number;
  billableDeliveryWait: number;
  excessWeightLb: number;
  afterHours: boolean;
  weekend: boolean;
  holidays: string[];
  fuelBasisCents: number;
  fuelCents: number;
  totalCents: number;
  warnings: string[];
}
export class RateError extends Error {}

export function blankAtlPricing(): AtlPricingInput {
  return {
    sheetId: ATL_SHEET.id,
    vehicleClass: "small-package",
    mileageBasis: "included-20",
    miles: null,
    vehicleCapacityLb: null,
    pickupWaitMinutes: 0,
    deliveryWaitMinutes: 0,
    trip: "one-way",
    loadedBothWays: false,
    fuelPercent: null,
    fuelBasis: null,
    secondAirlineCounter: false,
    airportRecoveryAttempts: 0,
    additionalDeliveryAttempts: 0,
    paperworkFaxed: false,
    dryIcePickup: false,
    dryIcePounds: 0,
    hazmat: false,
    holdOver: false,
    dryIceReplenish: false,
    liftGate: false,
    palletJack: false,
    helperHours: 0,
    helperHourlyRateCents: null,
  };
}

function numberField(
  value: unknown,
  label: string,
  max: number,
  decimals = 2,
): number {
  const factor = 10 ** decimals;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    Math.abs(value * factor - Math.round(value * factor)) > 0.000001
  ) {
    throw new RateError(
      `Enter a valid ${label} (0–${max}, ${decimals ? `up to ${decimals} decimal places` : "whole numbers"}).`,
    );
  }
  return Math.round(value * factor) / factor;
}

export function parseAtlPricing(value: unknown): AtlPricingInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RateError("Invalid ATL pricing details.");
  const data = value as Record<string, unknown>;
  const input = blankAtlPricing();
  if (data.sheetId !== ATL_SHEET.id)
    throw new RateError("Select a supported rate sheet version.");
  if (
    typeof data.vehicleClass !== "string" ||
    !Object.hasOwn(ATL_VEHICLES, data.vehicleClass)
  )
    throw new RateError("Select a rate vehicle class.");
  input.vehicleClass = data.vehicleClass as AtlVehicleClass;
  if (data.mileageBasis !== "included-20")
    throw new RateError(
      "Use the confirmed ATL mileage formula: small-package minimum versus mileage, or the van/truck base plus miles beyond 20.",
    );
  input.mileageBasis = data.mileageBasis;
  input.miles = numberField(data.miles, "route distance in miles", 10000);
  input.vehicleCapacityLb =
    input.vehicleClass === "box-truck"
      ? 9000
      : numberField(
          data.vehicleCapacityLb,
          "vehicle cargo capacity in pounds",
          10000,
        );
  if (!input.vehicleCapacityLb)
    throw new RateError(
      "Enter the actual vehicle cargo capacity. The sheet does not specify capacities for passenger vehicles or vans.",
    );
  for (const key of ["pickupWaitMinutes", "deliveryWaitMinutes"] as const)
    input[key] = numberField(data[key], "wait time in minutes", 10080, 0);
  if (!["one-way", "roundtrip", "return"].includes(String(data.trip)))
    throw new RateError("Select a valid trip type.");
  input.trip = data.trip as AtlPricingInput["trip"];
  for (const key of [
    "loadedBothWays",
    "secondAirlineCounter",
    "paperworkFaxed",
    "dryIcePickup",
    "hazmat",
    "holdOver",
    "dryIceReplenish",
    "liftGate",
    "palletJack",
  ] as const) {
    if (typeof data[key] !== "boolean")
      throw new RateError(`Confirm the ${key} selection.`);
    input[key] = data[key];
  }
  if (input.trip === "roundtrip" && !input.loadedBothWays)
    throw new RateError(
      "The 150% roundtrip rate requires freight in both directions. Confirm the load or use a separately quoted service.",
    );
  input.fuelPercent = numberField(
    data.fuelPercent,
    "confirmed fuel surcharge percentage",
    1000,
  );
  if (
    data.fuelBasis !== "transport" &&
    data.fuelBasis !== "subtotal" &&
    !(input.fuelPercent === 0 && data.fuelBasis === null)
  )
    throw new RateError("Confirm which charges the fuel surcharge applies to.");
  input.fuelBasis = data.fuelBasis as FuelBasis | null;
  for (const key of [
    "airportRecoveryAttempts",
    "additionalDeliveryAttempts",
  ] as const)
    input[key] = numberField(data[key], "additional attempt count", 10, 0);
  input.dryIcePounds = numberField(
    data.dryIcePounds,
    "dry ice weight in pounds",
    1000,
  );
  if (input.dryIcePickup && input.dryIcePounds === 0)
    throw new RateError(
      "Enter the dry ice weight so pickup includes the separately specified cost of ice.",
    );
  input.helperHours = numberField(data.helperHours, "helper hours", 168);
  input.helperHourlyRateCents =
    data.helperHourlyRateCents === null
      ? null
      : numberField(
          data.helperHourlyRateCents,
          "quoted helper hourly rate in cents",
          100_000_000,
          0,
        );
  if (
    input.helperHours > 0 &&
    (!input.helperHourlyRateCents || input.helperHourlyRateCents <= 0)
  )
    throw new RateError(
      "A helper is quote-only: enter the agreed hourly rate before calculating.",
    );
  if (
    input.vehicleClass !== "box-truck" &&
    (input.liftGate || input.palletJack || input.helperHours > 0)
  )
    throw new RateError(
      "Lift gate, pallet jack, and helper rates on this sheet apply to the box-truck class.",
    );
  return input;
}

const atlClock = new Intl.DateTimeFormat("en-US", {
  timeZone: ATL_SHEET.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function atlTime(iso: string) {
  if (
    !iso ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(iso) ||
    !Number.isFinite(Date.parse(iso))
  )
    throw new RateError(
      "Set the pickup start and delivery end to calculate Atlanta time-based charges.",
    );
  const parts = Object.fromEntries(
    atlClock
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
function holidayName(date: Date): string | null {
  const month = date.getUTCMonth() + 1,
    day = date.getUTCDate(),
    weekday = date.getUTCDay();
  if (month === 1 && day === 1) return "New Year’s Day";
  if (month === 5 && weekday === 1 && day >= 25) return "Memorial Day";
  if (month === 7 && day === 4) return "Independence Day";
  if (month === 9 && weekday === 1 && day <= 7) return "Labor Day";
  if (month === 11 && weekday === 4 && day >= 22 && day <= 28)
    return "Thanksgiving Day";
  if (month === 12 && day === 25) return "Christmas Day";
  return null;
}
export function atlCalendarCharges(start: string, end: string) {
  const from = atlTime(start),
    to = atlTime(end);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration < 0 || duration > 31 * 86400000)
    throw new RateError(
      "Use a valid service window of no more than 31 days for this ASAP rate sheet.",
    );
  const afterHours = [from.minute, to.minute].some(
    (minute) => minute >= 19 * 60 + 1 || minute <= 5 * 60 + 59,
  );
  let weekend = false;
  const holidays = new Set<string>();
  const last = Date.UTC(to.year, to.month - 1, to.day);
  // Iterate Atlanta calendar dates, not fixed UTC-hour intervals, so DST does
  // not shift the weekend/holiday or after-hours classification.
  for (
    let stamp = Date.UTC(from.year, from.month - 1, from.day);
    stamp <= last;
    stamp += 86400000
  ) {
    const date = new Date(stamp);
    weekend ||= date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const holiday = holidayName(date);
    if (holiday) holidays.add(holiday);
  }
  return { afterHours, weekend, holidays: [...holidays], from, to };
}

export function calculateAtlRate(
  value: unknown,
  shipment: RateShipment,
): { input: AtlPricingInput; charges: Charge[]; snapshot: AtlRateSnapshot } {
  const input = parseAtlPricing(value),
    profile = ATL_VEHICLES[input.vehicleClass];
  const weight = numberField(shipment.weight, "shipment weight", 10000);
  if (weight > input.vehicleCapacityLb!)
    throw new RateError(
      `Shipment weight exceeds the ${input.vehicleClass === "box-truck" ? "9,000 lb box-truck limit" : `${input.vehicleCapacityLb} lb vehicle cargo capacity`}. Request a suitable vehicle or a separate quote.`,
    );
  const calendar = atlCalendarCharges(shipment.start, shipment.end);
  const milesHundredths = Math.round(input.miles! * 100);
  const mileageCents = Math.round((milesHundredths * profile.perMile) / 100);
  const included =
    input.mileageBasis === "included-20" && profile.includedMiles > 0;
  const oneWayBaseCents = included
    ? profile.minimum +
      Math.round((Math.max(0, milesHundredths - 2000) * profile.perMile) / 100)
    : Math.max(profile.minimum, mileageCents);
  const tripCents = Math.round(
    (oneWayBaseCents *
      (input.trip === "roundtrip" ? 150 : input.trip === "return" ? 50 : 100)) /
      100,
  );
  const charges: Charge[] = [];
  const add = (description: string, rateCents: number, quantity = 1) => {
    if (rateCents > 0 && quantity > 0)
      charges.push({ description, quantity, rateCents });
  };
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const mileageDetail = included
    ? `${input.miles} mi; first 20 included`
    : `${input.miles} mi; minimum or mileage, whichever is greater`;
  add(
    `${input.trip === "roundtrip" ? "Roundtrip · 150%" : input.trip === "return" ? "Return · 50%" : "One-way transport"} · ${mileageDetail}${input.trip !== "one-way" ? ` of ${usd(oneWayBaseCents)} base` : ""}`,
    tripCents,
  );
  add(
    "Additional full delivery attempt · one-way base",
    oneWayBaseCents,
    input.additionalDeliveryAttempts,
  );
  const transportCents =
    tripCents + oneWayBaseCents * input.additionalDeliveryAttempts;
  const pickupWait = Math.max(0, input.pickupWaitMinutes - profile.freeWait),
    deliveryWait = Math.max(0, input.deliveryWaitMinutes - profile.freeWait);
  add(
    `Pickup waiting · ${profile.freeWait} minutes free`,
    profile.perWaitMinute,
    pickupWait,
  );
  add(
    `Delivery waiting · ${profile.freeWait} minutes free`,
    profile.perWaitMinute,
    deliveryWait,
  );
  const excessHundredths = Math.max(
    0,
    Math.round(weight * 100) - profile.freeWeight * 100,
  );
  add(
    `Excess weight · ${excessHundredths / 100} lb above ${profile.freeWeight} lb`,
    Math.round((excessHundredths * profile.perPound) / 100),
  );
  if (calendar.afterHours)
    add("After hours · Atlanta start/end 19:01–05:59", profile.afterHours);
  if (calendar.weekend)
    add("Weekend service · Saturday/Sunday", profile.weekend);
  if (calendar.holidays.length)
    add(`Holiday service · ${calendar.holidays.join(", ")}`, profile.holiday);
  if (input.liftGate) add("Lift gate · per truck", 5000);
  if (input.palletJack) add("Pallet jack · per truck", 1500);
  if (input.secondAirlineCounter) add("Second airline counter", 2000);
  add("Airport recovery attempt", 1800, input.airportRecoveryAttempts);
  if (input.paperworkFaxed) add("MAWB / paperwork faxed", 600);
  if (input.dryIcePickup) add("Dry ice pickup · excludes ice cost", 2500);
  if (input.dryIcePounds > 0) {
    const date = `${calendar.from.year}-${String(calendar.from.month).padStart(2, "0")}-${String(calendar.from.day).padStart(2, "0")}`;
    if (date < ATL_SHEET.dryIcePriceDate)
      throw new RateError(
        "The sheet only supplies a dry ice price dated September 25, 2026. Confirm earlier ice pricing using a manual quote.",
      );
    add(
      `Dry ice · ${input.dryIcePounds} lb at $3.25/lb (09/25/2026)`,
      Math.round((Math.round(input.dryIcePounds * 100) * 325) / 100),
    );
  }
  if (input.hazmat) add("HazMat fee", 2000);
  if (input.holdOver) add("Hold over and ship later", 2000);
  if (input.dryIceReplenish) add("Dry ice replenishment", 3000);
  if (input.helperHours > 0)
    add(
      `Second person · ${input.helperHours} hr at ${usd(input.helperHourlyRateCents!)}/hr · manually quoted`,
      Math.round(
        (Math.round(input.helperHours * 100) * input.helperHourlyRateCents!) /
          100,
      ),
    );
  const subtotal = charges.reduce(
    (sum, charge) => sum + charge.quantity * charge.rateCents,
    0,
  );
  const fuelBasisCents =
    input.fuelBasis === "subtotal" ? subtotal : transportCents;
  const fuelCents = Math.round(
    (fuelBasisCents * Math.round(input.fuelPercent! * 100)) / 10000,
  );
  add(
    `Fuel surcharge · ${input.fuelPercent}% of ${input.fuelBasis === "subtotal" ? "pre-fuel subtotal" : "transport charges"} (${usd(fuelBasisCents)})`,
    fuelCents,
  );
  const totalCents = subtotal + fuelCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > 100_000_000)
    throw new RateError(
      "Quote total exceeds $1,000,000. Request a separate quote.",
    );
  const warnings: string[] = [];
  if (calendar.from.year !== 2026 || calendar.to.year !== 2026)
    warnings.push(
      "This sheet is labelled 2026. Confirm its validity for this service date.",
    );
  return {
    input,
    charges,
    snapshot: {
      sheetId: ATL_SHEET.id,
      sourceSha256: ATL_SHEET.sha256,
      vehicleClass: input.vehicleClass,
      timeZone: ATL_SHEET.timeZone,
      oneWayBaseCents,
      transportCents,
      billablePickupWait: pickupWait,
      billableDeliveryWait: deliveryWait,
      excessWeightLb: excessHundredths / 100,
      afterHours: calendar.afterHours,
      weekend: calendar.weekend,
      holidays: calendar.holidays,
      fuelBasisCents,
      fuelCents,
      totalCents,
      warnings,
    },
  };
}
