// Saves a priced quote in Xcelerator the way the back-office Order Entry
// screen does in Quote mode (Mode > Quote, Ctrl+2): the order is stored as a
// quote with its own "Q..." reference, not as a live order, so nothing is
// dispatched. Found by reading Order Entry's scripts (2026-11-18):
//
//  1. POST api/order/getNewOrderTrackingId      reserves an order number
//  2. POST orders/Shared/_Order                 the order form (gives UserId and Login for the save)
//  3. POST api/order/getDefaultOrderInfo        the account's default order (ClientId 0 + AccountNo, as the screen sends it)
//  4. POST api/order/getSelectData              the account's services, vehicles and packages
//  5. POST xApi/orderwebapi/saveNewOrder        the order with AltOrderType "Q"; answers { Error, AltRefId: "Q..." }
//  (api/order/clearTemps releases a reserved number that is not saved, as the screen does on close.)
//
// The price is the rate sheet's, written in as a manual price (OverRide 2,
// which stops Xcelerator's tariff rules): transport, weight, waiting and
// after-hours in their own charge fields, everything else in Misc ("Rate
// sheet extras"). Auto-notifications and auto-dispatch are switched off on
// the quote, so saving it can never email the customer or send a driver.
//
// Verified 2026-11-18 with test quote Q1 under TEST COMPANY [TESTR]: account,
// caller, addresses, service, vehicle, weight, mileage, packages and every
// charge field were stored. Xcelerator does not keep target times or
// comments on a quote (they are set when it becomes an order), so the
// itemized lines stay on the card and in the reply.
//
// Server-only: signs in with XCELERATOR_BACKOFFICE_USERNAME / _PASSWORD.

import { geocodePlace } from "./google-maps";
import { backOfficeRequest, isBackOfficeConfigured } from "./xcelerator-backoffice";
import {
  VEHICLE_CLASSES,
  VEHICLE_LABELS,
  formatCents,
  type FuelBasis,
  type QuoteInputs,
  type QuoteResult,
  type VehicleClass,
} from "./quote-types";

export function isXceleratorQuoteConfigured(): boolean {
  return isBackOfficeConfigured();
}

export class XceleratorQuoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Accounts ---------------------------------------------------------------------

export type XceleratorAccount = { clientId: number; accountNo: string; companyName: string; city: string; state: string };

type ClientRow = { ClientId: number; AccountNo: string; CompanyName: string; City?: string | null; State?: string | null };

function toAccount(row: ClientRow): XceleratorAccount {
  return {
    clientId: row.ClientId,
    accountNo: row.AccountNo?.trim() ?? "",
    companyName: row.CompanyName?.trim() ?? "",
    city: row.City?.trim() ?? "",
    state: row.State?.trim() ?? "",
  };
}

/** Order Entry's account search: accounts whose company name (or account no) starts with `prefix`. */
async function getClients(prefix: string, field: "CompanyName" | "AccountNo"): Promise<XceleratorAccount[]> {
  const query = new URLSearchParams({ _p_Prefix: prefix, _p_Field: field, $top: "10" });
  const data = await backOfficeRequest<{ Items?: ClientRow[] } | null>(`/api/order/getClients?${query}`, { get: true });
  return (data?.Items ?? []).filter((r) => r && r.ClientId > 0).map(toAccount);
}

/** Accounts matching what a CSR typed: by company name, and by account no when it could be one. */
export async function searchXceleratorAccounts(text: string): Promise<XceleratorAccount[]> {
  const q = text.trim().slice(0, 60);
  if (q.length < 2) return [];
  const searches = [getClients(q, "CompanyName")];
  if (!/\s/.test(q) && q.length <= 12) searches.push(getClients(q, "AccountNo"));
  const seen = new Set<number>();
  return (await Promise.all(searches)).flat().filter((a) => !seen.has(a.clientId) && seen.add(a.clientId));
}

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|comcast|att|bellsouth|verizon|protonmail|proton)$/i;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The sender's Xcelerator account when it is clear which one: the one
 * account whose name matches the sender's email domain ("piedmont.org"
 * finds PIEDMONT ...). Several matches, or none, leave it to the CSR; the
 * other accounts found are offered as choices.
 */
export async function suggestXceleratorAccount(
  senderEmail: string,
  places: (string | null)[],
): Promise<{ account: XceleratorAccount | null; candidates: XceleratorAccount[] }> {
  const domain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  const labels = domain.split(".");
  const root = labels.length >= 2 ? labels[labels.length - 2] : "";
  const fromDomain = root.length >= 3 && !FREE_MAIL.test(root);
  const terms = new Set<string>();
  // A domain runs the words together ("questdiagnostics"), so its start is searched.
  if (fromDomain) terms.add(root.length > 6 ? root.slice(0, 5) : root);
  for (const place of places) {
    const name = place?.split(",")[0].trim().split(/\s+/)[0] ?? "";
    if (name.length >= 3 && !/^\d/.test(name)) terms.add(name);
  }
  const found = await Promise.all([...terms].slice(0, 3).map((t) => getClients(t, "CompanyName").catch(() => [])));
  const seen = new Set<number>();
  const candidates = found.flat().filter((a) => !seen.has(a.clientId) && seen.add(a.clientId)).slice(0, 8);
  // The domain names the account when the account's name starts with the whole domain
  // ("piedmont" > Piedmont Healthcare) or the domain starts with the account's first word
  // ("questdiagnostics" > Quest Diagnostics).
  const byDomain = fromDomain
    ? candidates.filter((a) => {
        const name = squash(a.companyName);
        const firstWord = squash(a.companyName.split(/\s+/)[0] ?? "");
        return name.startsWith(root) || (firstWord.length >= 4 && root.startsWith(firstWord));
      })
    : [];
  return { account: byDomain.length === 1 ? byDomain[0] : null, candidates };
}

async function accountByNumber(accountNo: string): Promise<XceleratorAccount> {
  const match = (await getClients(accountNo.trim(), "AccountNo")).find(
    (a) => a.accountNo.toLowerCase() === accountNo.trim().toLowerCase(),
  );
  if (!match) throw new XceleratorQuoteError(404, `Xcelerator has no account ${accountNo}.`);
  return match;
}

// --- Building the quote --------------------------------------------------------

export type QuoteForXcelerator = {
  accountNo: string;
  inputs: QuoteInputs;
  quote: QuoteResult;
  pickupAddress: string;
  deliveryAddress: string;
  pieces: number | null;
  pallets: number | null;
  /** Who asked for the quote, saved as the quote's caller. */
  callerName: string;
};

export type PlannedAddress = { coName: string; street: string; city: string; state: string; zip: string; matched: string };

/** What will be (or was) saved, for the card to show before and after the save. */
export type XceleratorQuotePlan = {
  account: XceleratorAccount;
  pickup: PlannedAddress;
  delivery: PlannedAddress;
  vehicle: string;
  service: string;
  packages: string | null;
  charges: { label: string; amount: string }[];
  total: string;
  notes: string[];
};

type SurchargeRow = {
  SurchargeName?: string | null;
  SurchargeValue?: number | null;
  /** "P" percent, "F" fixed, "M" per mile. */
  FixedOrPercent?: string | null;
  /** Vehicle ids it applies to; "0" is every vehicle. */
  VehicleIdArray?: string | null;
  /** Service ids it applies to; "0" is every service. */
  ServiceIdArray?: string | null;
  UseDateRange?: boolean | null;
  /** "from:to:value:driverValue,..." with US dates. */
  DateRange?: string | null;
  ChargePayPercentageOptionsCSV?: string | null;
};

type SelectData = {
  VehicleTypes?: { Id: number; VehicleName: string }[];
  ServiceTypes?: { Id: number; ServiceName: string; IsDefault?: boolean }[];
  Packages?: { PackageId: number; Package: string }[];
  Surcharges?: SurchargeRow[];
};

type DefaultOrder = Record<string, unknown> & {
  ClientId?: number;
  AccountNo?: string;
  CompanyName?: string;
  TerminalId?: number;
  ServiceId?: number;
  ClientStatus?: string;
};

const VEHICLE_NAMES: Record<VehicleClass, RegExp[]> = {
  "small-package": [/\bcar\b|sedan|small/i],
  "cargo-van": [/cargo\s*van/i, /\bvan\b/i],
  "cube-sprinter": [/sprinter|cube|high\s*roof/i, /cargo\s*van/i, /\bvan\b/i],
  "box-truck": [/box|straight/i, /truck/i],
};

/** The account's vehicle type for a rate-sheet vehicle: the best-named one, else a near one. */
function matchVehicle(
  vehicles: { Id: number; VehicleName: string }[],
  vehicleClass: VehicleClass,
): { Id: number; VehicleName: string } | undefined {
  for (const pattern of VEHICLE_NAMES[vehicleClass]) {
    const found = vehicles.find((v) => pattern.test(v.VehicleName));
    if (found) return found;
  }
  return undefined;
}

function cents(n: number): number {
  return Math.round(n) / 100;
}

/** Atlanta wall clock "YYYY-MM-DDTHH:mm" as Order Entry's "MM/DD/YYYY HH:mm". */
function oeTime(wall: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) throw new XceleratorQuoteError(400, `Bad time ${wall}.`);
  return `${m[2]}/${m[3]}/${m[1]} ${m[4]}:${m[5]}`;
}

/** An instant as Order Entry writes CreationUTC: Atlanta "MM/DD/YY HH:mm EST|EDT". */
function oeCreation(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

async function plannedAddress(place: string, side: string): Promise<PlannedAddress> {
  const found = await geocodePlace(place);
  if (!found || !found.city || !found.state || !found.zip) {
    throw new XceleratorQuoteError(
      422,
      `Couldn't find the city, state and ZIP of the ${side} place ("${place}"), which Xcelerator requires. Make it more specific on the card.`,
    );
  }
  const first = place.split(",")[0].trim();
  // The business name as the email wrote it, unless it is just the street or the city.
  const isName = first && !/^\d/.test(first) && squash(first) !== squash(found.city);
  return {
    coName: (isName ? first.replace(/\s+in\s+[A-Za-z .]+$/i, "") : "").slice(0, 75),
    street: found.street.slice(0, 100),
    city: found.city.slice(0, 75),
    state: found.state.slice(0, 3),
    zip: found.zip.slice(0, 10),
    matched: found.formatted,
  };
}

/** The rate sheet's charge lines in Order Entry's charge fields; what has no field of its own goes in Misc. */
function chargeFields(quote: QuoteResult) {
  const f = { OrderCharge: 0, WaitTimeCharge: 0, WeightCharge: 0, AfterHoursCharge: 0, MiscCharge: 0 };
  const lines: { label: string; amount: string }[] = [];
  for (const c of quote.charges) {
    const amount = c.quantity * c.rateCents;
    const d = c.description;
    const field: keyof typeof f = /^(One-way transport|Roundtrip|Return|Additional full delivery attempt)/.test(d)
      ? "OrderCharge"
      : /waiting/i.test(d)
        ? "WaitTimeCharge"
        : /^Excess weight/.test(d)
          ? "WeightCharge"
          : /^After hours/.test(d)
            ? "AfterHoursCharge"
            : "MiscCharge";
    f[field] += amount;
    lines.push({ label: d, amount: formatCents(amount, quote.currency) });
  }
  const total = Object.values(f).reduce((a, b) => a + b, 0);
  if (total !== quote.totalCents) {
    throw new XceleratorQuoteError(500, "The charge lines don't add up to the quoted total, so the quote wasn't saved.");
  }
  return { fields: f, lines, totalCents: total };
}

// --- Fuel surcharge --------------------------------------------------------------
//
// The rate sheet leaves the fuel surcharge out ("request current FSC"), but
// Xcelerator keeps the current one as account surcharges that Order Entry
// loads with the account's select data and applies by vehicle and delivery
// date. Read 2026-11-18 (AIRP, AIRGR, PIEDHO, all the same): "Gas Srch"
// 14.72% for cars, vans and Sprinters, "Diesel Src" 21.7% for straight
// trucks, both a percentage of the order charge only, which is where the
// rate sheet's transport lines are saved (see chargeFields).

export type XceleratorFuelSurcharge = {
  percent: number;
  basis: FuelBasis;
  /** Xcelerator's name for it, e.g. "Gas Srch". */
  name: string;
};

export type XceleratorFuelSurcharges = {
  /** The account it was read from. */
  accountNo: string;
  /** Whether that is the sender's own account, rather than any account (the surcharges are company-wide). */
  sendersAccount: boolean;
  byVehicle: Partial<Record<VehicleClass, XceleratorFuelSurcharge>>;
};

const FUEL_NAME = /fuel|gas|diesel|fsc/i;
// ChargePayPercentageOptionsCSV starts with one flag per charge field the percentage is taken of, in this order.
const PERCENT_BASIS_FIELDS = [
  "OrderCharge",
  "ClientDiscountAmt",
  "OnlineDiscountAmt",
  "RoundTripCharge",
  "OtherChg1",
  "OtherChg2",
  "MiscCharge",
  "HourlyCharge",
  "PackageCharge",
  "WeightCharge",
  "InsuranceCharge",
  "CODCharge",
  "WaitTimeCharge",
  "WarehousingCharge",
  "StopOffCharge",
  "StopOffExtras",
  "TotalExtras",
  "AfterHoursCharge",
];
// The fields a quote's transport charge is saved in (discounts are always 0 on a rate-sheet quote).
const TRANSPORT_FIELDS = new Set(["OrderCharge", "RoundTripCharge", "ClientDiscountAmt", "OnlineDiscountAmt"]);

function basisOf(row: SurchargeRow): FuelBasis | null {
  const flags = (row.ChargePayPercentageOptionsCSV ?? "").split(",");
  const on = PERCENT_BASIS_FIELDS.filter((_, i) => flags[i]?.trim() === "1");
  if (on.length === 0) return null;
  return on.every((field) => TRANSPORT_FIELDS.has(field)) ? "transport" : "subtotal";
}

/** "MM/DD/YYYY..." as "YYYY-MM-DD". */
function isoDay(us: string | undefined): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(us ?? "");
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/** The surcharge's value on `day` ("YYYY-MM-DD"), from its date ranges when it has them. */
function surchargeValue(row: SurchargeRow, day: string): number | null {
  if (!row.UseDateRange) {
    return typeof row.SurchargeValue === "number" && Number.isFinite(row.SurchargeValue) ? row.SurchargeValue : null;
  }
  for (const range of (row.DateRange ?? "").split(",")) {
    const [from, to, value] = range.split(":");
    const a = isoDay(from);
    const b = isoDay(to);
    if (a && b && a <= day && day <= b && value?.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function listed(ids: string | null | undefined, id: number | null): boolean {
  const list = (ids ?? "").split(",").map((s) => s.trim());
  return list.includes("0") || (id !== null && list.includes(String(id)));
}

/**
 * The fuel surcharge Order Entry would put on this vehicle, on the delivery
 * `day`. With no `serviceId` (not chosen yet) only surcharges for every
 * service count. Null when none applies or they can't be told as one figure.
 */
function fuelFor(
  select: SelectData | null,
  vehicleClass: VehicleClass,
  day: string,
  serviceId: number | null = null,
): XceleratorFuelSurcharge | null {
  const vehicle = matchVehicle(select?.VehicleTypes ?? [], vehicleClass);
  if (!vehicle) return null;
  let percent = 0;
  let basis: FuelBasis | null = null;
  const names: string[] = [];
  for (const row of select?.Surcharges ?? []) {
    if (row.FixedOrPercent !== "P" || !FUEL_NAME.test(row.SurchargeName ?? "")) continue;
    if (!listed(row.VehicleIdArray, vehicle.Id) || !listed(row.ServiceIdArray, serviceId)) continue;
    const value = surchargeValue(row, day);
    const rowBasis = basisOf(row);
    if (value === null || !rowBasis) continue;
    // Two fuel surcharges on different charges can't be one percentage on the card.
    if (basis && basis !== rowBasis) return null;
    basis = rowBasis;
    percent += value;
    names.push(row.SurchargeName!.trim());
  }
  return basis ? { percent: Math.round(percent * 10000) / 10000, basis, name: names.join(" + ") } : null;
}

/** The account's select data, loaded the way Order Entry does when the account is picked; the reserved number is released. */
async function readAccountSelectData(accountNo: string): Promise<SelectData | null> {
  const reserved = await backOfficeRequest<{ OrderTrackingId?: number }>("/api/order/getNewOrderTrackingId");
  const orderTrackingId = reserved?.OrderTrackingId;
  if (!orderTrackingId) return null;
  try {
    await backOfficeRequest<string>("/orders/Shared/_Order", {
      form: new URLSearchParams({ _p_OrderTrackingId: String(orderTrackingId) }),
      text: true,
    });
    const defaults = await backOfficeRequest<DefaultOrder>(
      `/api/order/getDefaultOrderInfo?_p_ClientId=0&_p_AccountNo=${encodeURIComponent(accountNo)}&_p_OrderTrackingId=${orderTrackingId}&_p_IsMultiMode=false&_p_IsContinuation=false&_p_RouteId=0&_p_LastOrderTrackingId=0`,
    );
    if (!defaults?.ClientId) return null;
    return await backOfficeRequest<SelectData>(
      `/api/order/getSelectData?_p_ClientId=${defaults.ClientId}&_p_OrderTrackingId=${orderTrackingId}&_p_AltOrderId=0&_p_TerminalId=${defaults.TerminalId ?? 0}`,
    );
  } finally {
    await release(orderTrackingId);
  }
}

// Fuel surcharges change weekly at most; an account's are kept for an hour so
// opening quote emails doesn't reserve order numbers each time. "*" holds the
// last ones read from any account.
const FUEL_CACHE_MS = 60 * 60 * 1000;
const fuelCache = new Map<string, { at: number; day: string; value: Promise<XceleratorFuelSurcharges | null> }>();

async function fuelSurchargesOf(account: XceleratorAccount, day: string, sendersAccount: boolean) {
  const select = await readAccountSelectData(account.accountNo);
  const byVehicle: XceleratorFuelSurcharges["byVehicle"] = {};
  for (const vehicleClass of VEHICLE_CLASSES) {
    const fuel = fuelFor(select, vehicleClass, day);
    if (fuel) byVehicle[vehicleClass] = fuel;
  }
  return Object.keys(byVehicle).length > 0 ? { accountNo: account.accountNo, sendersAccount, byVehicle } : null;
}

function cached(key: string, day: string, load: () => Promise<XceleratorFuelSurcharges | null>) {
  const hit = fuelCache.get(key);
  if (hit && hit.day === day && Date.now() - hit.at < FUEL_CACHE_MS) return hit.value;
  const value = load().catch((err) => {
    fuelCache.delete(key);
    throw err;
  });
  fuelCache.set(key, { at: Date.now(), day, value });
  return value;
}

/**
 * The current fuel surcharge for each vehicle, as Xcelerator would put it on
 * an order delivered on `day` ("YYYY-MM-DD"): from the sender's account when
 * the email domain names one, else from any account (they are the same on
 * every account checked). Null when Xcelerator has none or isn't connected.
 */
export async function currentFuelSurcharges(
  senderEmail: string,
  places: (string | null)[],
  day: string,
): Promise<XceleratorFuelSurcharges | null> {
  if (!isXceleratorQuoteConfigured()) return null;
  const { account, candidates } = await suggestXceleratorAccount(senderEmail, places).catch(() => ({
    account: null,
    candidates: [] as XceleratorAccount[],
  }));
  if (account) {
    const own = await cached(account.accountNo, day, () => fuelSurchargesOf(account, day, true));
    if (own) return own;
  }
  return cached("*", day, async () => {
    // Any active account will do; a test account may have none, so a few are tried.
    const others = [...candidates, ...(await getClients("a", "CompanyName").catch(() => []))].filter(
      (a) => a.accountNo && a.accountNo !== account?.accountNo,
    );
    for (const other of others.slice(0, 3)) {
      const found = await fuelSurchargesOf(other, day, false);
      if (found) return found;
    }
    return null;
  });
}

type Prepared = {
  plan: XceleratorQuotePlan;
  orderTrackingId: number;
  payload: Record<string, unknown>;
  saveQuery: string;
};

async function prepare(req: QuoteForXcelerator): Promise<Prepared> {
  if (!isXceleratorQuoteConfigured()) {
    throw new XceleratorQuoteError(501, "Xcelerator's back office isn't connected (set XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD).");
  }
  const { fields: charges, lines, totalCents } = chargeFields(req.quote);
  const [account, pickup, delivery] = await Promise.all([
    accountByNumber(req.accountNo),
    plannedAddress(req.pickupAddress, "pickup"),
    plannedAddress(req.deliveryAddress, "delivery"),
  ]);

  // Reserved like opening Order Entry does; released below if anything fails.
  const reserved = await backOfficeRequest<{ OrderTrackingId?: number; CreationUtc?: string }>("/api/order/getNewOrderTrackingId");
  const orderTrackingId = reserved?.OrderTrackingId;
  if (!orderTrackingId) throw new XceleratorQuoteError(502, "Xcelerator didn't give an order number for the quote.");
  try {
    const form = await backOfficeRequest<string>("/orders/Shared/_Order", {
      form: new URLSearchParams({ _p_OrderTrackingId: String(orderTrackingId) }),
      text: true,
    });
    const hidden = (id: string) => new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(form)?.[1] ?? "";
    const userId = hidden("UserId");
    const login = hidden("Login");
    if (!userId || !login) throw new XceleratorQuoteError(502, "Xcelerator's order form didn't load, so the quote wasn't saved.");

    const defaults = await backOfficeRequest<DefaultOrder>(
      `/api/order/getDefaultOrderInfo?_p_ClientId=0&_p_AccountNo=${encodeURIComponent(account.accountNo)}&_p_OrderTrackingId=${orderTrackingId}&_p_IsMultiMode=false&_p_IsContinuation=false&_p_RouteId=0&_p_LastOrderTrackingId=0`,
    );
    if (!defaults?.ClientId) throw new XceleratorQuoteError(502, `Xcelerator didn't load account ${account.accountNo}.`);
    if (defaults.ClientStatus === "I" || defaults.ClientStatus === "L") {
      throw new XceleratorQuoteError(409, `Account ${account.accountNo} is ${defaults.ClientStatus === "I" ? "inactive" : "locked"} in Xcelerator.`);
    }
    const select = await backOfficeRequest<SelectData>(
      `/api/order/getSelectData?_p_ClientId=${defaults.ClientId}&_p_OrderTrackingId=${orderTrackingId}&_p_AltOrderId=0&_p_TerminalId=${defaults.TerminalId ?? 0}`,
    );

    const notes: string[] = [];
    const vehicles = select?.VehicleTypes ?? [];
    const vehicle = matchVehicle(vehicles, req.inputs.vehicleClass);
    if (!vehicle) {
      throw new XceleratorQuoteError(
        422,
        `Account ${account.accountNo} has no vehicle type for a ${VEHICLE_LABELS[req.inputs.vehicleClass].toLowerCase()} (it has ${vehicles.map((v) => v.VehicleName).join(", ") || "none"}).`,
      );
    }
    if (!VEHICLE_NAMES[req.inputs.vehicleClass][0].test(vehicle.VehicleName)) {
      notes.push(`This account has no ${VEHICLE_LABELS[req.inputs.vehicleClass]} type, so the quote uses ${vehicle.VehicleName}.`);
    }
    const services = select?.ServiceTypes ?? [];
    const service =
      services.find((s) => s.Id === defaults.ServiceId) ?? services.find((s) => s.IsDefault) ?? services[0];
    if (!service) throw new XceleratorQuoteError(422, `Account ${account.accountNo} has no service types in Xcelerator.`);

    // The account's own fuel surcharge, in case it differs from what the quote was priced with.
    const fuel = fuelFor(select, req.inputs.vehicleClass, req.inputs.deliveryEnd.slice(0, 10), service.Id);
    if (fuel && (Math.abs(fuel.percent - req.inputs.fuelPercent) > 0.001 || fuel.basis !== req.inputs.fuelBasis)) {
      notes.push(
        `This account's fuel surcharge in Xcelerator is ${fuel.percent}% (${fuel.name}) of ${fuel.basis === "transport" ? "transport charges" : "all charges"}; the quote used ${req.inputs.fuelPercent}% of ${req.inputs.fuelBasis === "transport" ? "transport charges" : "all charges"}.`,
      );
    }

    const packageList = select?.Packages ?? [];
    const pkg = req.pallets
      ? packageList.find((p) => /skid|pallet/i.test(p.Package))
      : (packageList.find((p) => /\bbox/i.test(p.Package)) ?? packageList[0]);
    const pkgCount = Math.max(1, Math.round(req.pallets ?? req.pieces ?? 1));

    const total = formatCents(totalCents, req.quote.currency);
    const overrides: Record<string, unknown> = {
      OrderTrackingId: orderTrackingId,
      CreationUTC: oeCreation(reserved.CreationUtc ?? new Date().toISOString()),
      AltOrderType: "Q",
      Status: "N",
      OrderType: "PD",
      ServiceId: service.Id,
      VehicleId: vehicle.Id,
      CallerId: 0,
      Caller: req.callerName.slice(0, 75),
      PAddressId: 0,
      PCoName: pickup.coName,
      PStreet: pickup.street,
      PCity: pickup.city,
      PState: pickup.state,
      PZip: pickup.zip,
      DAddressId: 0,
      DCoName: delivery.coName,
      DStreet: delivery.street,
      DCity: delivery.city,
      DState: delivery.state,
      DZip: delivery.zip,
      PickupTargetFrom: oeTime(req.inputs.pickupStart),
      PickupTargetTo: null,
      DeliveryTargetFrom: null,
      DeliveryTargetTo: oeTime(req.inputs.deliveryEnd),
      sWeight: Number(req.inputs.weight.toFixed(2)),
      RoundTrip: req.inputs.trip === "roundtrip",
      MileageTotal: req.inputs.miles,
      OverRideMileage: true,
      // The rate sheet's price, entered by hand (2 = every charge manual, no tariff rules).
      OverRide: 2,
      HasRated: true,
      OrderCharge: cents(charges.OrderCharge),
      WaitTimeCharge: cents(charges.WaitTimeCharge),
      WeightCharge: cents(charges.WeightCharge),
      AfterHoursCharge: cents(charges.AfterHoursCharge),
      MiscCharge: cents(charges.MiscCharge),
      MiscChargeDtl: charges.MiscCharge > 0 ? "Rate sheet extras" : "",
      ClientDiscountAmt: 0,
      OnlineDiscountAmt: 0,
      OtherChg1: 0,
      OtherChg2: 0,
      HourlyCharge: 0,
      PackageCharge: 0,
      InsuranceCharge: 0,
      CODCharge: 0,
      WarehousingCharge: 0,
      StopOffCharge: 0,
      StopOffExtras: 0,
      TotalExtras: 0,
      TotalSurcharges: 0,
      Tax1Amount: 0,
      Tax2Amount: 0,
      TollCharge: 0,
      TotalCharge: cents(totalCents),
      Subtotal: cents(totalCents),
      GrandTotal: cents(totalCents),
      Packages: pkg ? [{ Package: `PkgNum${pkg.PackageId}`, PackageCount: String(pkgCount) }] : [],
      Extras: [],
      SpecialAttributes: [],
      // A quote must never notify anyone or reach a driver.
      AutoDispatchStatus: false,
    };
    for (const key of Object.keys(defaults)) if (key.startsWith("AutoNotify_")) overrides[key] = false;

    return {
      orderTrackingId,
      payload: { ...defaults, ...overrides },
      saveQuery: `?_p_UseTerminalAutoAssignment=${encodeURIComponent(hidden("UseTerminalAutoAssignment") || "0")}&_p_UserId=${encodeURIComponent(userId)}&_p_Login=${encodeURIComponent(login)}`,
      plan: {
        account: { ...account, companyName: defaults.CompanyName?.trim() || account.companyName },
        pickup,
        delivery,
        vehicle: vehicle.VehicleName,
        service: service.ServiceName,
        packages: pkg ? `${pkgCount} × ${pkg.Package}` : null,
        charges: lines,
        total,
        notes,
      },
    };
  } catch (err) {
    await release(orderTrackingId);
    throw err;
  }
}

/** Frees a reserved order number that won't be saved, as Order Entry does when a screen closes. */
async function release(orderTrackingId: number): Promise<void> {
  await backOfficeRequest(`/api/order/clearTemps?_p_OrderTrackingId=${orderTrackingId}`).catch(() => {});
}

/** Everything the quote would be saved with, worked out in Xcelerator but not saved. */
export async function previewXceleratorQuote(req: QuoteForXcelerator): Promise<XceleratorQuotePlan> {
  const prepared = await prepare(req);
  await release(prepared.orderTrackingId);
  return prepared.plan;
}

export type SavedXceleratorQuote = XceleratorQuotePlan & {
  /** The quote's reference in Xcelerator, e.g. "Q1234". */
  quoteRef: string;
};

/** Saves the quote in Xcelerator under the account; answers its "Q..." reference. */
export async function saveXceleratorQuote(req: QuoteForXcelerator): Promise<SavedXceleratorQuote> {
  const prepared = await prepare(req);
  let saved: { Error?: string | null; AltRefId?: string | null } | null;
  try {
    saved = await backOfficeRequest(`/xApi/orderwebapi/saveNewOrder${prepared.saveQuery}`, {
      json: prepared.payload,
      timeoutMs: 30_000,
    });
  } catch (err) {
    await release(prepared.orderTrackingId);
    throw new XceleratorQuoteError(502, `Xcelerator didn't save the quote: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (saved?.Error) {
    await release(prepared.orderTrackingId);
    throw new XceleratorQuoteError(502, `Xcelerator didn't save the quote: ${saved.Error}`);
  }
  const quoteRef = saved?.AltRefId?.trim() ?? "";
  if (!/^Q/i.test(quoteRef)) {
    // Something was saved but not as a quote; say so instead of claiming success.
    throw new XceleratorQuoteError(
      502,
      `Xcelerator answered without a quote number (got "${quoteRef || "nothing"}"). Check order ${prepared.orderTrackingId} in Xcelerator.`,
    );
  }
  return { ...prepared.plan, quoteRef };
}
