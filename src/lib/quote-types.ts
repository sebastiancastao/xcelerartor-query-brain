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

/** What the rate sheet assumes for each vehicle, and the waiting and weight it includes. */
export const VEHICLE_SHEET_NOTES: Record<VehicleClass, string> = {
  "small-package": "Passenger-class vehicle · 15 min free wait each end · 100 lb included",
  "cargo-van": "½ ton and up cargo van · 15 min free wait each end · 100 lb included",
  "cube-sprinter": "15′ cube van or Sprinter · 15 min free wait each end · 100 lb included",
  "box-truck": "24′–26′ single-axle truck · 60 min free wait each end · 2,000 lb included, 9,000 lb max",
};

export const TRIPS = ["one-way", "roundtrip", "return"] as const;
export type Trip = (typeof TRIPS)[number];

export const TRIP_LABELS: Record<Trip, string> = {
  "one-way": "One way",
  roundtrip: "Round trip, freight both ways (150%)",
  return: "Return (50%)",
};

export type FuelBasis = "transport" | "subtotal";

/** A fuel surcharge as the quote card uses it: a percentage of the transport charge or of all charges. */
export type FuelSurchargeEntry = {
  percent: number;
  basis: FuelBasis;
  /** Its name in Xcelerator, e.g. "Gas Srch". */
  name: string;
};

export type FuelSurchargeDefaults = Record<VehicleClass, FuelSurchargeEntry>;

/**
 * The fuel surcharge the quote card uses when Xcelerator's current one can't
 * be read (back office not connected, no answer, or none for the vehicle).
 * These are Xcelerator's own as read 2026-11-18 on AIRP, AIRGR and PIEDHO:
 * "Gas Srch" 14.72% for cars, vans and Sprinters, "Diesel Src" 21.7% for
 * straight trucks, both on the order (transport) charge only. The server can
 * replace them with QUOTE_FUEL_GAS_PERCENT, QUOTE_FUEL_DIESEL_PERCENT and
 * QUOTE_FUEL_BASIS (see fuel-defaults.ts).
 */
export const DEFAULT_FUEL_SURCHARGES: FuelSurchargeDefaults = {
  "small-package": { percent: 14.72, basis: "transport", name: "Gas Srch" },
  "cargo-van": { percent: 14.72, basis: "transport", name: "Gas Srch" },
  "cube-sprinter": { percent: 14.72, basis: "transport", name: "Gas Srch" },
  "box-truck": { percent: 21.7, basis: "transport", name: "Diesel Src" },
};

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
  /** Pallets or skids, when the email gives the count. */
  pallets: number | null;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  pickupStart: string | null;
  /** Atlanta wall-clock time, "YYYY-MM-DDTHH:mm". */
  deliveryEnd: string | null;
  trip: Trip | null;
  extras: QuoteExtra[];
  dryIcePounds: number | null;
  /** Minutes the driver is expected to wait at pickup, only when the email says. */
  pickupWaitMinutes: number | null;
  /** Minutes the driver is expected to wait at delivery, only when the email says. */
  deliveryWaitMinutes: number | null;
  /** Full delivery attempts beyond the first that the email asks for. */
  additionalDeliveryAttempts: number | null;
  /** Airport recovery attempts beyond the first that the email asks for. */
  airportRecoveryAttempts: number | null;
  /** Hours of a second person (helper or team driver), when the email gives them. */
  helperHours: number | null;
  /** The email asks for a second person, helper, two-man team or team drivers. */
  needsHelper: boolean;
};

/**
 * What the AI judged about the load where the email gives no figure. Only
 * used where the email does not state the value, and always shown on the
 * card so the CSR can check it. The vehicle itself is never the AI's pick:
 * `pickVehicle` sizes it from these and the stated details.
 */
export type QuoteEstimates = {
  /** Total pounds, estimated from the items described. */
  weight: number | null;
  weightReason: string | null;
  /** An item too big for a van (furniture, large equipment), in a few words; null when there is none. */
  truckItem: string | null;
};

export const NO_ESTIMATES: QuoteEstimates = { weight: null, weightReason: null, truckItem: null };

export type QuoteField = keyof QuoteRequestFields;

export const QUOTE_FIELD_LABELS: Record<QuoteField, string> = {
  vehicleClass: "Vehicle",
  miles: "Route miles",
  weight: "Weight",
  pieces: "Pieces",
  pallets: "Pallets",
  pickupAddress: "Pickup from",
  deliveryAddress: "Deliver to",
  pickupStart: "Pickup time",
  deliveryEnd: "Delivery by",
  trip: "Trip",
  extras: "Extras",
  dryIcePounds: "Dry ice",
  pickupWaitMinutes: "Wait at pickup",
  deliveryWaitMinutes: "Wait at delivery",
  additionalDeliveryAttempts: "Extra delivery attempts",
  airportRecoveryAttempts: "Airport recovery attempts",
  helperHours: "Helper hours",
  needsHelper: "Second person",
};

/** An earlier message of the open email's thread, as plain text with its quoted history cut off. */
export type ThreadMessage = { from: string; sentAt: string | null; text: string };

/** What the quote was read from besides the open email. */
export type QuoteSourcesRead = {
  /** Earlier messages of the thread that were read. */
  threadMessages: number;
  /** Attachments and document links read, by name. */
  documents: string[];
  /** Documents that were not read, with why. */
  skipped: { name: string; why: string }[];
  /** Why no attachment could be read at all (the app's Missive token can't see the email, ...). */
  documentsUnavailable: string | null;
};

export type QuoteRequestDetection = {
  isQuoteRequest: boolean;
  /** One line saying what the customer wants priced. */
  summary: string;
  fields: QuoteRequestFields;
  estimates: QuoteEstimates;
  /** Where a field came from when it wasn't the open email: "an earlier message" or a document's name. */
  fieldSources?: Partial<Record<QuoteField, string>>;
  read?: QuoteSourcesRead;
  /** Set when the AI could not read the email, so the fields are empty for that reason, not because the email lacks them. */
  unreadReason?: string;
};

/**
 * Cargo each vehicle carries, in pounds. The rate sheet fixes only the box
 * truck (9,000 lb); the others are standard courier figures, used unless a
 * CSR enters a different capacity for their vehicle.
 */
export const VEHICLE_CAPACITY_LB: Record<VehicleClass, number> = {
  "small-package": 500,
  "cargo-van": 3000,
  "cube-sprinter": 3500,
  "box-truck": 9000,
};

/** Standard pallets each vehicle takes. A car takes none; more than a box truck's needs a separate quote. */
export const VEHICLE_PALLETS: Record<VehicleClass, number> = {
  "small-package": 0,
  "cargo-van": 2,
  "cube-sprinter": 4,
  "box-truck": 12,
};

export type LoadForSizing = {
  weight: number | null;
  pallets: number | null;
  truckItem: string | null;
  extras: QuoteExtra[];
  /** A second person is asked for; the sheet offers helpers with box trucks only. */
  helper: boolean;
};

/**
 * The vehicle to price when the email names none: the smallest one (the
 * cheapest on the rate sheet, which charges more per vehicle size) that holds
 * the weight and the pallets, and a box truck for an item too big for a van or
 * when a lift gate or pallet jack is asked for (box truck only on the sheet).
 * `reason` names the rule that decided it.
 */
export function pickVehicle(load: LoadForSizing): { vehicleClass: VehicleClass; reason: string } {
  const rank = (v: VehicleClass) => VEHICLE_CLASSES.indexOf(v);
  let pick: { vehicleClass: VehicleClass; reason: string } =
    load.weight === null
      ? { vehicleClass: "small-package", reason: "smallest vehicle, until the weight is known" }
      : {
          vehicleClass: VEHICLE_CLASSES.find((v) => load.weight! <= VEHICLE_CAPACITY_LB[v]) ?? "box-truck",
          reason: `smallest vehicle for ${load.weight.toLocaleString("en-US")} lb`,
        };
  const atLeast = (vehicleClass: VehicleClass, reason: string) => {
    if (rank(vehicleClass) > rank(pick.vehicleClass)) pick = { vehicleClass, reason };
  };
  if (load.pallets) {
    const pallets = load.pallets;
    atLeast(
      VEHICLE_CLASSES.find((v) => pallets <= VEHICLE_PALLETS[v]) ?? "box-truck",
      `${pallets} pallet${pallets === 1 ? "" : "s"}`,
    );
  }
  if (load.truckItem) atLeast("box-truck", load.truckItem);
  if (load.extras.some((extra) => BOX_TRUCK_ONLY_EXTRAS.includes(extra))) {
    atLeast("box-truck", "lift gate or pallet jack asked for, box truck only");
  }
  if (load.helper) atLeast("box-truck", "second person asked for, box truck only on the sheet");
  return pick;
}

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
  pickupWaitMinutes: number;
  deliveryWaitMinutes: number;
  additionalDeliveryAttempts: number;
  airportRecoveryAttempts: number;
  helperHours: number;
  /** The agreed hourly rate for a second person in dollars; the sheet prices helpers by quote only. */
  helperHourlyRate: number | null;
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

/**
 * The delivery deadline to price when the email gives none: the drive time
 * plus an hour for loading and unloading after pickup, and never under two
 * hours. Atlanta wall-clock in and out; `pickupStart` unchanged when malformed.
 */
export function assumedDeliveryEnd(pickupStart: string, driveMinutes: number | null): string {
  const start = easternWallClockToIso(pickupStart);
  if (!start) return pickupStart;
  const minutes = Math.max(120, (driveMinutes ?? 0) + 60);
  return toEasternWallClock(new Date(Date.parse(start) + minutes * 60000));
}

// Two-letter codes are matched in capitals only, so "in", "me" and "or" in a place name don't count.
const US_STATE_CODE =
  /\b(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\b|\b\d{5}\b/;
const US_STATE_NAME =
  /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+(?:hampshire|jersey|mexico|york)|(?:north|south)\s+(?:carolina|dakota)|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming)\b/i;

/**
 * The place as sent to Google Maps. Customers usually name Atlanta-area places
 * without a state ("LabCorp in Norcross"), so one without a state or ZIP is
 * looked up in Georgia; the Google Maps link on the card uses the same text.
 */
export function routeAddress(place: string): string {
  const value = place.trim();
  return US_STATE_CODE.test(value) || US_STATE_NAME.test(value) ? value : `${value}, GA`;
}
