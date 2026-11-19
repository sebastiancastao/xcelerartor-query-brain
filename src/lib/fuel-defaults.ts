import {
  DEFAULT_FUEL_SURCHARGES,
  VEHICLE_CLASSES,
  type FuelBasis,
  type FuelSurchargeDefaults,
  type QuoteFuelAssignment,
} from "./quote-types";
import { currentFuelSurcharges, isXceleratorQuoteConfigured } from "./xcelerator-quote";

/** Longest the quote reading waits for Xcelerator's surcharges before using the defaults. */
const XCELERATOR_WAIT_MS = 15_000;

/**
 * The fuel surcharge a quote is given when the email states none: Xcelerator's
 * current one for each vehicle (from the sender's account, else any account),
 * with the defaults for any vehicle it has none for. Never throws.
 */
export async function fuelAssignmentFor(
  senderEmail: string,
  places: (string | null)[],
  day: string = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
): Promise<QuoteFuelAssignment> {
  const defaults = fuelSurchargeDefaults();
  if (!isXceleratorQuoteConfigured()) {
    return { xcelerator: null, defaults, unavailable: "Xcelerator's back office isn't connected" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const table = await Promise.race([
      currentFuelSurcharges(senderEmail, places, day),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), XCELERATOR_WAIT_MS);
      }),
    ]);
    if (table === "timeout") return { xcelerator: null, defaults, unavailable: "Xcelerator took too long to answer" };
    return { xcelerator: table, defaults, unavailable: table ? null : "Xcelerator has no fuel surcharge set up" };
  } catch (err) {
    console.error("Fuel surcharge lookup failed:", err);
    return { xcelerator: null, defaults, unavailable: "Couldn't read the fuel surcharge from Xcelerator" };
  } finally {
    clearTimeout(timer);
  }
}

function percentFromEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw.replace(/%$/, ""));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function basisFromEnv(): FuelBasis | null {
  const raw = process.env.QUOTE_FUEL_BASIS?.trim().toLowerCase();
  return raw === "transport" || raw === "subtotal" ? raw : null;
}

/**
 * The quote card's fallback fuel surcharge for each vehicle: the built-in
 * figures (Xcelerator's own when last read), with QUOTE_FUEL_GAS_PERCENT
 * (car, van, Sprinter), QUOTE_FUEL_DIESEL_PERCENT (box truck) and
 * QUOTE_FUEL_BASIS ("transport" or "subtotal") taking their place when set,
 * so the figure can follow a new FSC without a code change.
 */
export function fuelSurchargeDefaults(): FuelSurchargeDefaults {
  const gas = percentFromEnv("QUOTE_FUEL_GAS_PERCENT");
  const diesel = percentFromEnv("QUOTE_FUEL_DIESEL_PERCENT");
  const basis = basisFromEnv();
  const out = { ...DEFAULT_FUEL_SURCHARGES };
  for (const vehicleClass of VEHICLE_CLASSES) {
    const builtIn = DEFAULT_FUEL_SURCHARGES[vehicleClass];
    const percent = vehicleClass === "box-truck" ? diesel : gas;
    out[vehicleClass] = {
      percent: percent ?? builtIn.percent,
      basis: basis ?? builtIn.basis,
      name: builtIn.name,
    };
  }
  return out;
}
