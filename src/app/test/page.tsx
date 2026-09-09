"use client";

import { useState } from "react";
import type { ReactNode } from "react";

type DebugOrderRow = {
  orderTrackingId: string | null;
  accountNo: string | null;
  oDate: string | null;
  status: string | null;
  clientRefNo: string | null;
  pickupCompany: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupTargetFrom: string | null;
  pickupArrival: string | null;
  deliveryCompany: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryTargetFrom: string | null;
  deliveryArrival: string | null;
  podCompletion: string | null;
  hasPodSignature: boolean | null;
  podName: string | null;
  grandTotal: number | null;
  chargeBreakdown: { label: string; amount: number }[];
  documents: { name: string | null; fileFormat: string | null }[];
};

type DebugSource = "axis" | "portal";

type DebugState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; source: DebugSource; count: number; orders: DebugOrderRow[] };

type BadgeTone = "emerald" | "amber" | "zinc";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300",
  zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${BADGE_TONE_CLASSES[tone]}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

function formatMaybeDate(value: string | null): string {
  if (!value) return "TBD";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "TBD" : date.toLocaleString();
}

function formatLocation(city: string | null, state: string | null): string {
  return [city, state].filter(Boolean).join(", ") || "—";
}

function formatBool(value: boolean | null): string {
  return value === null ? "—" : value ? "Yes" : "No";
}

function formatMoney(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatCharges(items: { label: string; amount: number }[]): string {
  if (items.length === 0) return "—";
  return items.map((item) => `${item.label}: ${formatMoney(item.amount)}`).join(", ");
}

function formatDocuments(docs: { name: string | null; fileFormat: string | null }[]): string {
  if (docs.length === 0) return "—";
  return docs.map((doc) => doc.name ?? doc.fileFormat ?? "file").join(", ");
}

function isoDayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysAgoIsoDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDayOf(date);
}

export default function TestPage() {
  const [from, setFrom] = useState(() => daysAgoIsoDay(365));
  const [to, setTo] = useState(() => isoDayOf(new Date()));
  const [state, setState] = useState<DebugState>({ status: "idle" });

  async function handleFetch() {
    setState({ status: "loading" });

    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/axis/all-orders?${params.toString()}`);
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setState({ status: "error", message: body?.error ?? `Request failed (${res.status})` });
        return;
      }

      setState({
        status: "success",
        source: (body?.source as DebugSource) ?? "axis",
        count: body?.count ?? 0,
        orders: (body?.orders ?? []) as DebugOrderRow[],
      });
    } catch {
      setState({ status: "error", message: "Network error — please try again." });
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-gradient-to-b from-zinc-50 to-white font-sans dark:from-zinc-950 dark:to-zinc-900">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            GetAllOrders (test)
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Calls GET /v4/Order/GetAllOrders on the real Axis API directly — any order
            status. Falls back to the ClientPortal session (all statuses, not just
            completed, scoped to AXIS_ACCOUNT_NO) if Axis rejects the request.
          </p>
        </header>

        <section className="rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900 sm:p-5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </label>
            <button
              type="button"
              onClick={handleFetch}
              disabled={state.status === "loading"}
              className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
            >
              {state.status === "loading" ? "Calling Axis…" : "Call /v4/Order/GetAllOrders"}
            </button>
          </div>

          {state.status === "error" && (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300">
              {state.message}
            </p>
          )}

          {state.status === "success" && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  {state.count} order{state.count === 1 ? "" : "s"} returned.
                </p>
                <Badge tone={state.source === "axis" ? "emerald" : "amber"}>
                  {state.source === "axis" ? "Source: Axis API" : "Source: ClientPortal fallback"}
                </Badge>
              </div>

              {state.orders.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[2200px] border-collapse text-left text-sm">
                    <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Tracking ID</th>
                        <th className="py-2 pr-4 font-medium">Account No</th>
                        <th className="py-2 pr-4 font-medium">Client Ref</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Pickup Co.</th>
                        <th className="py-2 pr-4 font-medium">Pickup Loc.</th>
                        <th className="py-2 pr-4 font-medium">Pickup Target</th>
                        <th className="py-2 pr-4 font-medium">Pickup Arrival</th>
                        <th className="py-2 pr-4 font-medium">Delivery Co.</th>
                        <th className="py-2 pr-4 font-medium">Delivery Loc.</th>
                        <th className="py-2 pr-4 font-medium">Delivery Target</th>
                        <th className="py-2 pr-4 font-medium">Delivery Arrival</th>
                        <th className="py-2 pr-4 font-medium">POD Completion</th>
                        <th className="py-2 pr-4 font-medium">POD Signed</th>
                        <th className="py-2 pr-4 font-medium">POD Received By</th>
                        <th className="py-2 pr-4 font-medium">Grand Total</th>
                        <th className="py-2 pr-4 font-medium">Charge Breakdown</th>
                        <th className="py-2 pr-4 font-medium">Documents</th>
                        <th className="py-2 font-medium">Order Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {state.orders.map((raw, i) => (
                        <tr key={raw.orderTrackingId ?? i}>
                          <td className="py-3 pr-4 font-medium text-zinc-900 dark:text-zinc-100">
                            {raw.orderTrackingId ?? "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {raw.accountNo || "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {raw.clientRefNo || "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">{raw.status || "—"}</td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {raw.pickupCompany || "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatLocation(raw.pickupCity, raw.pickupState)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.pickupTargetFrom)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.pickupArrival)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {raw.deliveryCompany || "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatLocation(raw.deliveryCity, raw.deliveryState)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.deliveryTargetFrom)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.deliveryArrival)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.podCompletion)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatBool(raw.hasPodSignature)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {raw.podName || "—"}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatMoney(raw.grandTotal)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatCharges(raw.chargeBreakdown)}
                          </td>
                          <td className="py-3 pr-4 text-zinc-700 dark:text-zinc-300">
                            {formatDocuments(raw.documents)}
                          </td>
                          <td className="py-3 text-zinc-700 dark:text-zinc-300">
                            {formatMaybeDate(raw.oDate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
