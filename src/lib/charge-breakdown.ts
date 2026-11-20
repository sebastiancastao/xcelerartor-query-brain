// An order's charges split the way billing reads them: base charge,
// accessorials, extras, fuel (and any other) surcharges, taxes and tolls,
// and the grand total. Read-only: nothing here changes an order.
//
// Two sources:
//  - "review_order": the back office's Review Order screen
//    (getReviewOrderData + getSelectData with _p_Screen=RO), itemized: each
//    accessorial charge field, each extra on the order with its count and
//    price, each surcharge with its rate. Needs XCELERATOR_BACKOFFICE_*.
//  - "client_portal": the ClientPortal order window's charge rows, which are
//    only totals ("Base", "Extras", "Surcharges", "Grand Total").
//
// How Xcelerator adds them up (checked 2026-11-20 on 60 recent completed
// orders, all of which matched to the cent): TotalCharge = OrderCharge + the
// accessorial fields + TotalExtras + StopOffExtras; Subtotal = TotalCharge +
// TotalSurcharges; GrandTotal = Subtotal + Tax1Amount + Tax2Amount + TollCharge.

export type ChargeLine = {
  label: string;
  amount: number;
  /** How the amount was reached, e.g. "1 × $10.00" or "6% rate". */
  detail?: string | null;
};

export type SurchargeLine = ChargeLine & {
  /** A fuel surcharge (Gas Srch, Diesel Src, ... FSC); null when the source can't tell. */
  fuel: boolean | null;
};

export type ChargeBreakdown = {
  source: "review_order" | "client_portal";
  /** The base (order) charge. */
  base: number | null;
  /** Charge fields on top of the base: wait time, after hours, weight, misc, discounts (negative), ... */
  accessorials: ChargeLine[];
  /** Extras picked on the order (Paperwork Faxed/Emailed, 2nd Man, ...). */
  extras: ChargeLine[];
  surcharges: SurchargeLine[];
  taxesAndTolls: ChargeLine[];
  grandTotal: number | null;
  /**
   * How the order was priced, from the Review Order screen: "tariff" (rated
   * by Xcelerator), "fixed_base" (base typed in, the rest rated) or "manual"
   * (every charge typed in). Null from the ClientPortal.
   */
  pricing: "tariff" | "fixed_base" | "manual" | null;
  /** Grand total minus the sum of every line, when they differ by a cent or more. */
  unexplained: number | null;
};

const FUEL_NAME = /fuel|gas|diesel|fsc/i;

const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => `$${n.toFixed(2)}`;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** The sum of every line of a breakdown (base included). */
export function breakdownLinesTotal(b: Pick<ChargeBreakdown, "base" | "accessorials" | "extras" | "surcharges" | "taxesAndTolls">): number {
  const sum = (lines: ChargeLine[]) => lines.reduce((total, l) => total + l.amount, 0);
  return (b.base ?? 0) + sum(b.accessorials) + sum(b.extras) + sum(b.surcharges) + sum(b.taxesAndTolls);
}

function withUnexplained(b: Omit<ChargeBreakdown, "unexplained">): ChargeBreakdown {
  if (b.grandTotal === null) return { ...b, unexplained: null };
  const diff = cents(b.grandTotal) - cents(breakdownLinesTotal(b));
  return { ...b, unexplained: diff === 0 ? null : diff / 100 };
}

/**
 * The ClientPortal order window's charge rows ("Base", "Extras",
 * "Surcharges"; "Grand Total" is passed separately) as a breakdown. The
 * window shows totals only, so extras and surcharges are one line each and a
 * surcharge is only marked as fuel when its label says so. Null when the
 * window had no charge rows.
 */
export function breakdownFromPortalLines(
  lines: { label: string; amount: number }[],
  grandTotal: number | null,
): ChargeBreakdown | null {
  if (!lines.length) return null;
  let base: number | null = null;
  const accessorials: ChargeLine[] = [];
  const extras: ChargeLine[] = [];
  const surcharges: SurchargeLine[] = [];
  const taxesAndTolls: ChargeLine[] = [];
  for (const { label, amount } of lines) {
    if (/^base/i.test(label)) base = (base ?? 0) + amount;
    else if (amount === 0) continue;
    else if (/extra/i.test(label)) extras.push({ label, amount, detail: "total; not itemized in the ClientPortal" });
    else if (/surch|fuel|fsc/i.test(label)) {
      const fuel = FUEL_NAME.test(label) ? true : null;
      surcharges.push({ label, amount, fuel, detail: fuel ? null : "total; may include fuel" });
    } else if (/tax|toll/i.test(label)) taxesAndTolls.push({ label, amount });
    else accessorials.push({ label, amount });
  }
  return withUnexplained({
    source: "client_portal",
    base,
    accessorials,
    extras,
    surcharges,
    taxesAndTolls,
    grandTotal,
    pricing: null,
  });
}

/** The getReviewOrderData fields a breakdown is built from (all amounts in dollars). */
export type ReviewOrderCharges = Partial<Record<string, unknown>> & {
  OrderCharge?: number | null;
  TotalExtras?: number | null;
  StopOffExtras?: number | null;
  TotalSurcharges?: number | null;
  GrandTotal?: number | null;
  MiscChargeDtl?: string | null;
  Tax1Name?: string | null;
  Tax2Name?: string | null;
  OverRide?: number | null;
};

/** An extra in getSelectData (_p_Screen=RO): the account's whole list, with this order's count and charge. */
export type SelectExtra = {
  Extra?: string | null;
  ValueType?: string | null;
  Amount?: number | null;
  AmountStr?: string | null;
  /** e.g. "100.00" (a string in the API). */
  MinAmount?: string | number | null;
  ExtraCount?: number | null;
  FreeCount?: number | null;
  ExtraCharge?: number | null;
};

/** A surcharge in getSelectData (_p_Screen=RO): ClientAmount is what this order was charged. */
export type SelectSurcharge = {
  SurchargeName?: string | null;
  SurchargeChosen?: string | number | null;
  SurchargeValue?: number | null;
  FixedOrPercent?: string | null;
  ClientAmount?: number | null;
};

// Charge fields that sit on top of the base charge, in Review Order's order.
const ACCESSORIAL_FIELDS: [field: string, label: string][] = [
  ["RoundTripCharge", "Round trip"],
  ["WaitTimeCharge", "Wait time"],
  ["AfterHoursCharge", "After hours"],
  ["WeightCharge", "Weight"],
  ["HourlyCharge", "Hourly"],
  ["PackageCharge", "Packages"],
  ["StopOffCharge", "Stop-offs"],
  ["InsuranceCharge", "Insurance"],
  ["CODCharge", "COD fee"],
  ["WarehousingCharge", "Warehousing"],
  ["MiscCharge", "Misc"],
  ["OtherChg1", "Other charge 1"],
  ["OtherChg2", "Other charge 2"],
];
const DISCOUNT_FIELDS: [field: string, label: string][] = [
  ["ClientDiscountAmt", "Client discount"],
  ["OnlineDiscountAmt", "Online discount"],
];

function extraDetail(x: SelectExtra): string | null {
  const count = num(x.ExtraCount);
  const free = num(x.FreeCount);
  const price = x.AmountStr?.trim() || (x.Amount != null ? money(num(x.Amount)) : "");
  const parts: string[] = [];
  const minimum = num(x.MinAmount);
  if (x.ValueType === "U" && count) {
    parts.push(`${count} × ${price}`);
    // e.g. 2nd Man: 1 × $27.50, charged $100.00 (the account's minimum).
    if (minimum && cents(num(x.ExtraCharge)) === cents(minimum) && cents(count * num(x.Amount)) < cents(minimum))
      parts.push(`${money(minimum)} minimum`);
  }
  else if ((x.ValueType === "P" || x.ValueType === "T") && x.Amount != null) parts.push(`${num(x.Amount)}%`);
  else if (x.ValueType === "F") parts.push("flat");
  if (free > 0) parts.push(`${free} free`);
  return parts.join(", ") || null;
}

/**
 * The Review Order screen's charges as a breakdown. `select` is getSelectData
 * (_p_Screen=RO) for the same order, which names each extra and surcharge;
 * without it (or when its lines don't reach the order's totals) the missing
 * part is shown as one "not itemized" line, so the lines still add up.
 */
export function breakdownFromReviewOrder(
  order: ReviewOrderCharges,
  select: { Extras?: SelectExtra[] | null; Surcharges?: SelectSurcharge[] | null } | null,
): ChargeBreakdown {
  const accessorials: ChargeLine[] = [];
  for (const [field, label] of ACCESSORIAL_FIELDS) {
    const amount = num(order[field]);
    if (!amount) continue;
    const detail = field === "MiscCharge" ? order.MiscChargeDtl?.trim() || null : null;
    accessorials.push({ label, amount, detail });
  }
  for (const [field, label] of DISCOUNT_FIELDS) {
    const amount = num(order[field]);
    // Stored as an amount taken off; shown negative whichever sign it is kept with.
    if (amount) accessorials.push({ label, amount: -Math.abs(amount) });
  }

  const extras: ChargeLine[] = [];
  for (const x of select?.Extras ?? []) {
    const amount = num(x.ExtraCharge);
    if (!amount && !num(x.ExtraCount)) continue;
    extras.push({ label: x.Extra?.trim() || "Extra", amount, detail: extraDetail(x) });
  }
  const extrasDiff = cents(num(order.TotalExtras)) - cents(extras.reduce((t, l) => t + l.amount, 0));
  if (extrasDiff !== 0) {
    extras.push({
      label: extras.length ? "Other extras" : "Extras",
      amount: extrasDiff / 100,
      detail: select ? "not itemized by Xcelerator" : "total; itemized list not read",
    });
  }
  const stopOffExtras = num(order.StopOffExtras);
  if (stopOffExtras) extras.push({ label: "Stop-off extras", amount: stopOffExtras });

  const surcharges: SurchargeLine[] = [];
  for (const s of select?.Surcharges ?? []) {
    const amount = num(s.ClientAmount) || num(s.SurchargeChosen);
    if (!amount) continue;
    const name = s.SurchargeName?.trim() || "Surcharge";
    const rate = s.FixedOrPercent === "P" && s.SurchargeValue != null ? `${num(s.SurchargeValue)}% rate` : "flat";
    surcharges.push({ label: name, amount, fuel: FUEL_NAME.test(name), detail: rate });
  }
  const surchargeDiff = cents(num(order.TotalSurcharges)) - cents(surcharges.reduce((t, l) => t + l.amount, 0));
  if (surchargeDiff !== 0) {
    surcharges.push({
      label: surcharges.length ? "Other surcharges" : "Surcharges",
      amount: surchargeDiff / 100,
      fuel: null,
      detail: select ? "not itemized by Xcelerator" : "total; may include fuel",
    });
  }

  const taxesAndTolls: ChargeLine[] = [];
  const tax1 = num(order.Tax1Amount);
  if (tax1) taxesAndTolls.push({ label: order.Tax1Name?.trim() || "Tax", amount: tax1 });
  const tax2 = num(order.Tax2Amount);
  if (tax2) taxesAndTolls.push({ label: order.Tax2Name?.trim() || "Tax 2", amount: tax2 });
  const tolls = num(order.TollCharge);
  if (tolls) taxesAndTolls.push({ label: "Tolls", amount: tolls });

  const override = num(order.OverRide);
  return withUnexplained({
    source: "review_order",
    base: num(order.OrderCharge),
    accessorials,
    extras,
    surcharges,
    taxesAndTolls,
    grandTotal: order.GrandTotal == null ? null : num(order.GrandTotal),
    pricing: override === 2 ? "manual" : override === 1 ? "fixed_base" : "tariff",
  });
}

/** The breakdown as flat label/amount lines (for the AI reply), base first. */
export function breakdownAsLines(b: ChargeBreakdown): { label: string; amount: number; detail?: string }[] {
  const out: { label: string; amount: number; detail?: string }[] = [];
  if (b.base !== null) out.push({ label: "Base charge", amount: b.base });
  const add = (group: string, lines: ChargeLine[]) =>
    lines.forEach((l) => out.push({ label: `${group}: ${l.label}`, amount: l.amount, ...(l.detail ? { detail: l.detail } : {}) }));
  add("Accessorial", b.accessorials);
  add("Extra", b.extras);
  b.surcharges.forEach((l) =>
    out.push({
      label: `${l.fuel ? "Fuel surcharge" : "Surcharge"}: ${l.label}`,
      amount: l.amount,
      ...(l.detail ? { detail: l.detail } : {}),
    }),
  );
  add("Tax/toll", b.taxesAndTolls);
  return out;
}
