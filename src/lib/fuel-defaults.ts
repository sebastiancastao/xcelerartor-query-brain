import {
  DEFAULT_FUEL_SURCHARGES,
  VEHICLE_CLASSES,
  type FuelBasis,
  type FuelSurchargeDefaults,
} from "./quote-types";

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
