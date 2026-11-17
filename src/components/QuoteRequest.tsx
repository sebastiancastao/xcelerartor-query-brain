"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { InquiryEmail } from "@/lib/agent";
import { insertIntoMissiveReply, openLinkInNewTab } from "@/components/MissiveEmailSense";
import {
  BOX_TRUCK_ONLY_EXTRAS,
  QUOTE_EXTRAS,
  QUOTE_EXTRA_LABELS,
  TRIPS,
  TRIP_LABELS,
  VEHICLE_CLASSES,
  VEHICLE_LABELS,
  formatCents,
  toEasternWallClock,
  type FuelBasis,
  type QuoteExtra,
  type QuoteInputs,
  type QuoteRequestDetection,
  type QuoteResult,
  type Trip,
  type VehicleClass,
} from "@/lib/quote-types";

type Form = {
  vehicleClass: VehicleClass | "";
  miles: string;
  weight: string;
  capacity: string;
  pickupStart: string;
  deliveryEnd: string;
  fuelPercent: string;
  fuelBasis: FuelBasis | "";
  trip: Trip;
  extras: QuoteExtra[];
  dryIcePounds: string;
};

type CalcState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; quote: QuoteResult; reply: string };

type InsertState = { status: "idle" } | { status: "inserting" } | { status: "inserted" } | { status: "error"; message: string };

// The fuel surcharge and each vehicle's capacity are not on the rate sheet and
// rarely change, so the last values a CSR used are kept in this browser.
type SavedDefaults = { fuelPercent?: string; fuelBasis?: FuelBasis; capacity?: Partial<Record<VehicleClass, string>> };
const DEFAULTS_KEY = "web-agent.quote-defaults";

function loadDefaults(): SavedDefaults {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEFAULTS_KEY) ?? "{}") as SavedDefaults | null;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function saveDefaults(form: Form): void {
  try {
    const saved = loadDefaults();
    const capacity = { ...saved.capacity };
    if (form.vehicleClass && form.vehicleClass !== "box-truck" && form.capacity.trim()) {
      capacity[form.vehicleClass] = form.capacity.trim();
    }
    const next: SavedDefaults = {
      fuelPercent: form.fuelPercent.trim(),
      fuelBasis: form.fuelBasis || undefined,
      capacity,
    };
    window.localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked inside an iframe; the CSR just retypes the values.
  }
}

function num(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The inputs to price, or the names of the fields still to fill in. */
function buildInputs(form: Form): { inputs: QuoteInputs } | { missing: string[] } {
  const miles = num(form.miles);
  const weight = num(form.weight);
  const fuelPercent = num(form.fuelPercent);
  const capacity = num(form.capacity);
  const boxTruck = form.vehicleClass === "box-truck";
  const missing: string[] = [];
  if (!form.vehicleClass) missing.push("vehicle");
  if (miles === null) missing.push("route miles");
  if (weight === null) missing.push("weight");
  if (!boxTruck && !capacity) missing.push("vehicle capacity");
  if (!form.pickupStart) missing.push("pickup start");
  if (!form.deliveryEnd) missing.push("delivery by");
  if (fuelPercent === null) missing.push("fuel surcharge %");
  if (!form.fuelBasis) missing.push("fuel surcharge basis");
  if (
    missing.length > 0 ||
    !form.vehicleClass ||
    miles === null ||
    weight === null ||
    fuelPercent === null ||
    !form.fuelBasis
  ) {
    return { missing };
  }
  return {
    inputs: {
      vehicleClass: form.vehicleClass,
      miles,
      weight,
      vehicleCapacityLb: boxTruck ? null : capacity,
      pickupStart: form.pickupStart,
      deliveryEnd: form.deliveryEnd,
      fuelPercent,
      fuelBasis: form.fuelBasis,
      trip: form.trip,
      extras: form.extras.filter((extra) => boxTruck || !BOX_TRUCK_ONLY_EXTRAS.includes(extra)),
      dryIcePounds: num(form.dryIcePounds) ?? 0,
    },
  };
}

function initialForm(detection: QuoteRequestDetection): Form {
  const f = detection.fields;
  const saved = loadDefaults();
  const now = new Date();
  return {
    vehicleClass: f.vehicleClass ?? "",
    miles: f.miles?.toString() ?? "",
    weight: f.weight?.toString() ?? "",
    capacity: (f.vehicleClass && saved.capacity?.[f.vehicleClass]) || "",
    // With no time in the email the quote is priced as picked up now and
    // delivered within two hours; the card says so, so the CSR can change it.
    pickupStart: f.pickupStart ?? toEasternWallClock(now),
    deliveryEnd: f.deliveryEnd ?? toEasternWallClock(new Date(now.getTime() + 2 * 60 * 60 * 1000)),
    fuelPercent: saved.fuelPercent ?? "",
    fuelBasis: saved.fuelBasis ?? "",
    trip: f.trip ?? "one-way",
    extras: f.extras,
    dryIcePounds: f.dryIcePounds?.toString() ?? "",
  };
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-shadow focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-400";

function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

/**
 * Shown when the email open in Missive asks for a price quote. The details
 * the email states are filled in; the CSR adds the rest (route miles and the
 * fuel surcharge are never guessed), Quote Engine's rate sheet prices it, and
 * the reply with that price is drafted. No quote is saved anywhere and nothing is
 * sent: the CSR puts the reply into Missive and sends it there.
 */
export function QuoteRequest({
  detection,
  email,
  missiveHost,
  cardClass,
}: {
  detection: QuoteRequestDetection;
  /** The email the quote answers. */
  email: InquiryEmail;
  /** Whether Missive is hosting the page, so the reply can go into a draft there. */
  missiveHost: boolean;
  cardClass: string;
}) {
  const fields = detection.fields;
  const [form, setForm] = useState<Form>(() => initialForm(detection));
  // Priced straight away when the email (plus this browser's saved fuel
  // surcharge and capacity) already gives everything; otherwise the CSR
  // fills the gaps and presses Calculate.
  const [calc, setCalc] = useState<CalcState>(() => {
    const emailGaveAll = Boolean(
      fields.vehicleClass && fields.miles && fields.weight && fields.pickupStart && fields.deliveryEnd,
    );
    return emailGaveAll && "inputs" in buildInputs(initialForm(detection))
      ? { status: "loading" }
      : { status: "idle" };
  });
  const [copied, setCopied] = useState(false);
  const [insert, setInsert] = useState<InsertState>({ status: "idle" });
  const seqRef = useRef(0);

  async function runCalculation(current: Form) {
    const built = buildInputs(current);
    if (!("inputs" in built)) return;
    const seq = ++seqRef.current;
    try {
      const res = await fetch("/api/web-agent/quote/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: built.inputs,
          email,
          route: { pickupAddress: fields.pickupAddress, deliveryAddress: fields.deliveryAddress },
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { quote?: QuoteResult; reply?: string; error?: string }
        | null;
      if (seq !== seqRef.current) return;
      if (!res.ok || !data?.quote || typeof data.reply !== "string") {
        setCalc({ status: "error", message: data?.error ?? `Quote error (${res.status})` });
        return;
      }
      saveDefaults(current);
      setCalc({ status: "ready", quote: data.quote, reply: data.reply });
    } catch {
      if (seq === seqRef.current) setCalc({ status: "error", message: "Network error. Try again." });
    }
  }

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current || calc.status !== "loading") return;
    autoStartedRef.current = true;
    void runCalculation(form);
    // Runs once for the email this card was opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<Form>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function changeVehicle(vehicleClass: VehicleClass | "") {
    const savedCapacity = vehicleClass ? loadDefaults().capacity?.[vehicleClass] : undefined;
    update({ vehicleClass, capacity: savedCapacity ?? "" });
  }

  function toggleExtra(extra: QuoteExtra) {
    setForm((prev) => ({
      ...prev,
      extras: prev.extras.includes(extra) ? prev.extras.filter((e) => e !== extra) : [...prev.extras, extra],
    }));
  }

  async function handleCopy(value: string) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // Inside an iframe the Clipboard API is often blocked; use the older copy command.
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  async function handleInsert(value: string) {
    setInsert({ status: "inserting" });
    try {
      await insertIntoMissiveReply(value);
      setInsert({ status: "inserted" });
    } catch (error) {
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
      setInsert({ status: "error", message: (message || "Missive did not open the reply").replace(/\.+$/, "") });
    }
  }

  const built = buildInputs(form);
  const missing = "missing" in built ? built.missing : [];
  const boxTruck = form.vehicleClass === "box-truck";
  const notInEmail = [
    !fields.vehicleClass && "vehicle",
    !fields.miles && "route miles",
    !fields.weight && "weight",
    !fields.pickupStart && "pickup time",
    !fields.deliveryEnd && "delivery time",
  ].filter((v): v is string => Boolean(v));
  const assumedTimes = !fields.pickupStart || !fields.deliveryEnd;
  const directionsUrl =
    fields.pickupAddress && fields.deliveryAddress
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(fields.pickupAddress)}&destination=${encodeURIComponent(fields.deliveryAddress)}`
      : null;

  return (
    <section
      id="quote-request"
      className={`rounded-2xl border border-indigo-200 bg-white ${cardClass} shadow-sm dark:border-indigo-900/70 dark:bg-zinc-900`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Quote request</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
          This email asks for a price
        </span>
      </div>
      {detection.summary && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{detection.summary}</p>}

      {(fields.pickupAddress || fields.deliveryAddress || fields.pieces) && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {fields.pickupAddress && (
            <>
              <dt className="text-zinc-500 dark:text-zinc-400">From</dt>
              <dd className="text-zinc-800 dark:text-zinc-200">{fields.pickupAddress}</dd>
            </>
          )}
          {fields.deliveryAddress && (
            <>
              <dt className="text-zinc-500 dark:text-zinc-400">To</dt>
              <dd className="text-zinc-800 dark:text-zinc-200">{fields.deliveryAddress}</dd>
            </>
          )}
          {fields.pieces && (
            <>
              <dt className="text-zinc-500 dark:text-zinc-400">Pieces</dt>
              <dd className="text-zinc-800 dark:text-zinc-200">{fields.pieces}</dd>
            </>
          )}
        </dl>
      )}

      {detection.unreadReason && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-300">
          {detection.unreadReason}
        </p>
      )}

      {!detection.unreadReason && notInEmail.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Not in the email: {notInEmail.join(", ")}.
          {assumedTimes && " Times are set to pickup now and delivery in two hours (Atlanta time); change them if needed."}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length > 0) return;
          setCalc({ status: "loading" });
          setInsert({ status: "idle" });
          void runCalculation(form);
        }}
        className="mt-4 flex flex-col gap-4"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Labeled label="Vehicle">
            <select
              value={form.vehicleClass}
              onChange={(e) => changeVehicle(e.target.value as VehicleClass | "")}
              className={inputClass}
            >
              <option value="">Choose…</option>
              {VEHICLE_CLASSES.map((v) => (
                <option key={v} value={v}>
                  {VEHICLE_LABELS[v]}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Route miles">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.miles}
              onChange={(e) => update({ miles: e.target.value })}
              className={inputClass}
            />
            {directionsUrl && (
              <a
                href={directionsUrl}
                onClick={openLinkInNewTab}
                rel="noopener noreferrer"
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Check the route in Google Maps
              </a>
            )}
          </Labeled>
          <Labeled label="Weight (lb)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.weight}
              onChange={(e) => update({ weight: e.target.value })}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Vehicle capacity (lb)" hint={boxTruck ? "Box truck: fixed at 9,000 lb" : undefined}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              disabled={boxTruck}
              value={boxTruck ? "9000" : form.capacity}
              onChange={(e) => update({ capacity: e.target.value })}
              className={`${inputClass} disabled:opacity-60`}
            />
          </Labeled>
          <Labeled label="Pickup start (Atlanta)">
            <input
              type="datetime-local"
              value={form.pickupStart}
              onChange={(e) => update({ pickupStart: e.target.value })}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Delivery by (Atlanta)">
            <input
              type="datetime-local"
              value={form.deliveryEnd}
              onChange={(e) => update({ deliveryEnd: e.target.value })}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Fuel surcharge %">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.fuelPercent}
              onChange={(e) => update({ fuelPercent: e.target.value })}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Fuel surcharge on">
            <select
              value={form.fuelBasis}
              onChange={(e) => update({ fuelBasis: e.target.value as FuelBasis | "" })}
              className={inputClass}
            >
              <option value="">Choose…</option>
              <option value="transport">Transport charges only</option>
              <option value="subtotal">All charges</option>
            </select>
          </Labeled>
          <Labeled label="Trip">
            <select value={form.trip} onChange={(e) => update({ trip: e.target.value as Trip })} className={inputClass}>
              {TRIPS.map((t) => (
                <option key={t} value={t}>
                  {TRIP_LABELS[t]}
                </option>
              ))}
            </select>
          </Labeled>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {QUOTE_EXTRAS.filter((extra) => boxTruck || !BOX_TRUCK_ONLY_EXTRAS.includes(extra)).map((extra) => (
            <label key={extra} className="inline-flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={form.extras.includes(extra)}
                onChange={() => toggleExtra(extra)}
                className="h-4 w-4 rounded border-zinc-300 text-indigo-600 dark:border-zinc-700"
              />
              {QUOTE_EXTRA_LABELS[extra]}
            </label>
          ))}
          <label className="inline-flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            Dry ice (lb)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.dryIcePounds}
              onChange={(e) => update({ dryIcePounds: e.target.value })}
              className={`${inputClass} w-20`}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={missing.length > 0 || calc.status === "loading"}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
          >
            {calc.status === "loading" ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Calculating…
              </>
            ) : calc.status === "ready" ? (
              "Recalculate"
            ) : (
              "Calculate quote"
            )}
          </button>
          {missing.length > 0 && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Still needed: {missing.join(", ")}.</span>
          )}
        </div>
      </form>

      {calc.status === "error" && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300">
          {calc.message}
        </p>
      )}

      {calc.status === "ready" && (
        <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Quoted total</span>
            <span className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {formatCents(calc.quote.totalCents, calc.quote.currency)}
            </span>
          </div>
          <ul className="mt-2 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {calc.quote.charges.map((charge, i) => (
              <li key={`${i}-${charge.description}`} className="flex items-start justify-between gap-3 py-1.5">
                <span className="text-zinc-600 dark:text-zinc-400">
                  {charge.description}
                  {charge.quantity !== 1 && ` × ${charge.quantity}`}
                </span>
                <span className="shrink-0 text-zinc-800 dark:text-zinc-200">
                  {formatCents(charge.quantity * charge.rateCents, calc.quote.currency)}
                </span>
              </li>
            ))}
          </ul>
          {calc.quote.warnings.map((warning) => (
            <p
              key={warning}
              className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-300"
            >
              {warning}
            </p>
          ))}

          <div className="mb-3 mt-5 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Suggested reply with the quote</h3>
            <div className="flex items-center gap-2">
              {missiveHost && (
                <button
                  type="button"
                  onClick={() => void handleInsert(calc.reply)}
                  disabled={insert.status === "inserting"}
                  title="Opens a reply to this email in Missive with this text in it. Nothing is sent."
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
                >
                  {insert.status === "inserting" ? "Inserting…" : "Insert into reply"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleCopy(calc.reply)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={calc.reply}
            rows={10}
            className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
          />
          {insert.status === "inserted" && (
            <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
              Put into a reply in Missive. Nothing was sent: review it there and send it.
            </p>
          )}
          {insert.status === "error" && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              Couldn&apos;t put the reply into Missive ({insert.message}). Use Copy instead.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
