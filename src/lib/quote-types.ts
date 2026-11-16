// Shapes shared by the /web-agent quote card (browser) and the server code
// that reads a quote request out of an email and prices it with Quote Engine.
// Nothing here touches the network or the environment.

export const VEHICLE_CLASSES = ["small-package", "cargo-van", "cube-sprinter", "box-truck"] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const VEHICLE_LABELS: Record<VehicleClass, string> = {
  "small-package": "Small package / car",
  "cargo-van": "Cargo van",
  "cube-sprinter": "Cube van / Sprinter",
  "box-truck": "Box truck",
};

export const TRIPS = ["one-way", "roundtrip", "return"] as const;
export type Trip = (typeof TRIPS)[number];

export const TRIP_LABELS: Record<Trip, string> = {
  "one-way": "One way",
  roundtrip: "Round trip, freight both ways (150%)",
  return: "Return (50%)",
};

export type FuelBasis = "transport" | "subtotal";

/** Flat extras on the rate sheet, named as Quote Engine's pricing object names them. */
export const QUOTE_EXTRAS = [
  "hazmat",
  "dryIcePickup",
  "dryIceReplenish",
  "secondAirlineCounter",
  "paperworkFaxed",
  "holdOver",
  "liftGate",
  "palletJack",
] as const;
export type QuoteExtra = (typeof QUOTE_EXTRAS)[number];

export const QUOTE_EXTRA_LABELS: Record<QuoteExtra, string> = {
  hazmat: "HazMat",
  dryIcePickup: "Dry ice pickup",
  dryIceReplenish: "Dry ice replenishment",
  secondAirlineCounter: "Second airline counter",
  paperworkFaxed: "MAWB / paperwork faxed",
  holdOver: "Hold over, ship later",
  liftGate: "Lift gate",
  palletJack: "Pallet jack",
};

/** Extras the rate sheet only offers on a box truck. */
export const BOX_TRUCK_ONLY_EXTRAS: readonly QuoteExtra[] = ["liftGate", "palletJack"];

/** What the AI read out of a quote-request email. Anything the email does not state is null. */
export type QuoteRequestFields = {
  vehicleClass: VehicleClass | null;
  /** Route miles, only when the email states a distance. */
  miles: number | null;
  /** Total weight in pounds. */
  weight: number | null;
  pieces: number | null;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  pickupStart: string | null;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  deliveryEnd: string | null;
  trip: Trip | null;
  extras: QuoteExtra[];
  dryIcePounds: number | null;
};

export type QuoteRequestDetection = {
  isQuoteRequest: boolean;
  /** One line saying what the customer wants priced. */
  summary: string;
  fields: QuoteRequestFields;
};

/** Everything Quote Engine needs to price a shipment, as the CSR confirmed it. */
export type QuoteInputs = {
  vehicleClass: VehicleClass;
  miles: number;
  weight: number;
  /** The vehicle's cargo capacity in pounds. Ignored for a box truck, which is fixed at 9,000 lb. */
  vehicleCapacityLb: number | null;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  pickupStart: string;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  deliveryEnd: string;
  fuelPercent: number;
  fuelBasis: FuelBasis;
  trip: Trip;
  extras: QuoteExtra[];
  dryIcePounds: number;
};

export type QuoteCharge = { description: string; quantity: number; rateCents: number };

export type QuoteResult = {
  totalCents: number;
  currency: string;
  charges: QuoteCharge[];
  warnings: string[];
};

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

const EASTERN = "America/New_York";

/** How far Atlanta's clock is from UTC at the instant `t`, in ms (negative: behind UTC). */
function easternOffsetMs(t: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return wall - Math.floor(t / 60000) * 60000;
}

/** An Atlanta wall-clock time ("YYYY-MM-DDTHH:mm") as the UTC instant Quote Engine expects, or null when malformed. */
export function easternWallClockToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(asUtc)) return null;
  // Two passes: the offset depends on the instant, which depends on the offset (DST changes).
  let instant = asUtc - easternOffsetMs(asUtc);
  instant = asUtc - easternOffsetMs(instant);
  return new Date(instant).toISOString();
}

/** The instant `date` as an Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
export function toEasternWallClock(date: Date): string {
  const t = date.getTime();
  return new Date(t + easternOffsetMs(t)).toISOString().slice(0, 16);
}
