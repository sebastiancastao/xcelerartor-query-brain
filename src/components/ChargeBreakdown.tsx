"use client";

import type { ChargeBreakdown as Breakdown, ChargeLine } from "@/lib/charge-breakdown";

const PRICING_NOTE: Record<NonNullable<Breakdown["pricing"]>, string | null> = {
  tariff: null,
  fixed_base: "Base charge typed in by hand; the rest rated by Xcelerator",
  manual: "Priced by hand (every charge typed in, Xcelerator's rates overridden)",
};

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

const sum = (lines: ChargeLine[]) => lines.reduce((total, l) => total + l.amount, 0);

function Group({
  title,
  lines,
  currency,
  total,
}: {
  title: string;
  lines: ChargeLine[];
  currency: string;
  /** Shown on the heading row; defaults to the sum of the lines. */
  total?: number;
}) {
  const amount = total ?? sum(lines);
  const any = total !== undefined || lines.length > 0;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 pt-2 first:pt-0">
        <dt className="font-medium text-zinc-800 dark:text-zinc-200">{title}</dt>
        <dd className={`tabular-nums ${any ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"}`}>
          {any ? formatMoney(amount, currency) : "None"}
        </dd>
      </div>
      {lines.map((line, i) => (
        <div key={`${line.label}-${i}`} className="flex items-baseline justify-between gap-3 pl-3">
          <dt className="min-w-0 text-zinc-600 dark:text-zinc-400">
            {line.label}
            {line.detail && <span className="text-zinc-400 dark:text-zinc-500"> · {line.detail}</span>}
          </dt>
          <dd className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-400">{formatMoney(line.amount, currency)}</dd>
        </div>
      ))}
    </>
  );
}

/**
 * The order's charges split into base charge, accessorials, extras and fuel
 * surcharge (plus other surcharges, taxes and tolls when there are any),
 * ending with Xcelerator's grand total. Read-only.
 */
export function ChargeBreakdown({ breakdown, currency }: { breakdown: Breakdown; currency: string }) {
  const fuel = breakdown.surcharges.filter((s) => s.fuel !== false);
  const otherSurcharges = breakdown.surcharges.filter((s) => s.fuel === false);
  const pricingNote = breakdown.pricing ? PRICING_NOTE[breakdown.pricing] : null;

  return (
    <div className="mb-3.5 ml-9 rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Charge breakdown</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {breakdown.source === "review_order" ? "Itemized from Review Order" : "Totals from the ClientPortal"}
        </p>
      </div>
      <dl className="space-y-1 text-sm">
        <Group title="Base charge" lines={[]} currency={currency} total={breakdown.base ?? 0} />
        <Group title="Accessorials" lines={breakdown.accessorials} currency={currency} />
        <Group title="Extras" lines={breakdown.extras} currency={currency} />
        <Group title="Fuel surcharge" lines={fuel} currency={currency} />
        {otherSurcharges.length > 0 && <Group title="Other surcharges" lines={otherSurcharges} currency={currency} />}
        {breakdown.taxesAndTolls.length > 0 && (
          <Group title="Taxes & tolls" lines={breakdown.taxesAndTolls} currency={currency} />
        )}
        {breakdown.grandTotal !== null && (
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <dt className="font-semibold text-zinc-900 dark:text-zinc-100">Grand total</dt>
            <dd className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatMoney(breakdown.grandTotal, currency)}
            </dd>
          </div>
        )}
      </dl>
      {breakdown.unexplained !== null && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          The lines above come to {formatMoney(Math.abs(breakdown.unexplained), currency)}{" "}
          {breakdown.unexplained > 0 ? "less" : "more"} than the grand total; check the order in Review Order.
        </p>
      )}
      {pricingNote && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{pricingNote}</p>}
    </div>
  );
}
