"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { InquiryEmail } from "@/lib/agent";
import { insertIntoMissiveReply, openLinkInNewTab } from "@/components/MissiveEmailSense";
import { XceleratorQuoteSave } from "@/components/XceleratorQuoteSave";
import {
  BOX_TRUCK_ONLY_EXTRAS,
  DEFAULT_FUEL_SURCHARGES,
  QUOTE_EXTRAS,
  QUOTE_EXTRA_LABELS,
  QUOTE_FIELD_LABELS,
  TRIPS,
  TRIP_LABELS,
  VEHICLE_CAPACITY_LB,
  VEHICLE_CLASSES,
  VEHICLE_LABELS,
  VEHICLE_SHEET_NOTES,
  assumedDeliveryEnd,
  formatCents,
  pickVehicle,
  routeAddress,
  toEasternWallClock,
  type FuelBasis,
  type FuelSurchargeDefaults,
  type FuelSurchargeEntry,
  type LoadForSizing,
  type QuoteExtra,
  type QuoteField,
  type QuoteInputs,
  type QuoteRequestDetection,
  type QuoteResult,
  type Trip,
  type VehicleClass,
} from "@/lib/quote-types";
import type { XceleratorFuelSurcharges } from "@/lib/xcelerator-quote";

type Form = {
  pickupAddress: string;
  deliveryAddress: string;
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
  pickupWait: string;
  deliveryWait: string;
  deliveryAttempts: string;
  recoveryAttempts: string;
  /** A second person (helper or team driver); the sheet prices it by quote only, box truck only. */
  helper: boolean;
  helperHours: string;
  helperRate: string;
  // Which values were worked out rather than stated by the email or typed by
  // the CSR; worked-out ones follow the inputs they depend on.
  /** Picked by the sizing rules; re-picked when the weight changes. */
  vehicleAuto: boolean;
  /** The vehicle's standard (or saved) capacity, not typed on this card; follows the vehicle. */
  capacityAuto: boolean;
  /**
   * Not typed on this card: Xcelerator's current fuel surcharge for the
   * vehicle once read, else the default for the vehicle; follows the vehicle.
   */
  fuelAuto: boolean;
  /** The AI's estimate from the items the email describes. */
  weightAuto: boolean;
  pickupAuto: boolean;
  /** Set from the pickup time and drive time; follows both. */
  deliveryAuto: boolean;
  /** Google Maps' drive time for the route, once looked up. */
  driveMinutes: number | null;
};

type CalcState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      quote: QuoteResult;
      reply: string;
      /** What it was priced with, so a save to Xcelerator stores exactly this quote. */
      inputs: QuoteInputs;
      pickupAddress: string | null;
      deliveryAddress: string | null;
      seq: number;
    };

type MilesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; minutes: number | null };

type InsertState = { status: "idle" } | { status: "inserting" } | { status: "inserted" } | { status: "error"; message: string };

type FuelState =
  | { status: "loading" }
  | { status: "ready"; table: XceleratorFuelSurcharges }
  /** Xcelerator has none, isn't connected, or didn't answer: the default for the vehicle is used. */
  | { status: "unavailable"; message: string };

/** The fuel surcharge for a vehicle: Xcelerator's current one, else the default. */
function fuelChoice(
  vehicleClass: VehicleClass | "",
  table: XceleratorFuelSurcharges | null,
  defaults: FuelSurchargeDefaults,
): { entry: FuelSurchargeEntry; fromXcelerator: boolean } | null {
  if (!vehicleClass) return null;
  const current = table?.byVehicle[vehicleClass];
  return current ? { entry: current, fromXcelerator: true } : { entry: defaults[vehicleClass], fromXcelerator: false };
}

function isFuelDefaults(value: unknown): value is FuelSurchargeDefaults {
  if (!value || typeof value !== "object") return false;
  return VEHICLE_CLASSES.every((v) => {
    const entry = (value as Record<string, Partial<FuelSurchargeEntry> | undefined>)[v];
    return (
      typeof entry?.percent === "number" &&
      Number.isFinite(entry.percent) &&
      entry.percent >= 0 &&
      (entry.basis === "transport" || entry.basis === "subtotal") &&
      typeof entry.name === "string"
    );
  });
}

// A capacity a CSR entered that differs from the standard one for the vehicle
// is kept in this browser. (The fuel surcharge used to be kept too; it now
// comes from Xcelerator or the per-vehicle default, so a gas figure can't
// follow a CSR onto a box truck.)
type SavedDefaults = { capacity?: Partial<Record<VehicleClass, string>> };
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
    if (form.vehicleClass && form.vehicleClass !== "box-truck") {
      const value = form.capacity.trim();
      if (value && Number(value) !== VEHICLE_CAPACITY_LB[form.vehicleClass]) capacity[form.vehicleClass] = value;
      else delete capacity[form.vehicleClass];
    }
    const next: SavedDefaults = { capacity };
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
  const helperHours = form.helper ? num(form.helperHours) : 0;
  const helperRate = form.helper ? num(form.helperRate) : null;
  if (form.helper) {
    if (!boxTruck) missing.push("a box truck (the sheet offers a second person with box trucks only)");
    if (!helperHours) missing.push("helper hours");
    if (!helperRate) missing.push("helper hourly rate (priced by quote)");
  }
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
      pickupWaitMinutes: num(form.pickupWait) ?? 0,
      deliveryWaitMinutes: num(form.deliveryWait) ?? 0,
      additionalDeliveryAttempts: Math.round(num(form.deliveryAttempts) ?? 0),
      airportRecoveryAttempts: Math.round(num(form.recoveryAttempts) ?? 0),
      helperHours: helperHours ?? 0,
      helperHourlyRate: helperRate,
    },
  };
}

/** The vehicle's cargo capacity: the CSR's own figure saved in this browser, else the standard one. */
function capacityFor(vehicleClass: VehicleClass, saved: SavedDefaults = loadDefaults()): string {
  if (vehicleClass === "box-truck") return String(VEHICLE_CAPACITY_LB["box-truck"]);
  return saved.capacity?.[vehicleClass] || String(VEHICLE_CAPACITY_LB[vehicleClass]);
}

function initialForm(detection: QuoteRequestDetection): Form {
  const f = detection.fields;
  const estimates = detection.estimates;
  const saved = loadDefaults();
  const weight = f.weight ?? estimates.weight;
  const helper = f.needsHelper || f.helperHours !== null;
  const vehicleClass =
    f.vehicleClass ??
    pickVehicle({ weight, pallets: f.pallets, truckItem: estimates.truckItem, extras: f.extras, helper }).vehicleClass;
  // With no time in the email the quote is priced as picked up now, and
  // delivered after the drive plus an hour; the card says so.
  const pickupStart = f.pickupStart ?? toEasternWallClock(new Date());
  // The default fuel surcharge until Xcelerator's current one comes back.
  const fuel = DEFAULT_FUEL_SURCHARGES[vehicleClass];
  return {
    pickupAddress: f.pickupAddress ?? "",
    deliveryAddress: f.deliveryAddress ?? "",
    vehicleClass,
    miles: f.miles?.toString() ?? "",
    weight: weight?.toString() ?? "",
    capacity: capacityFor(vehicleClass, saved),
    pickupStart,
    deliveryEnd: f.deliveryEnd ?? assumedDeliveryEnd(pickupStart, null),
    fuelPercent: String(fuel.percent),
    fuelBasis: fuel.basis,
    trip: f.trip ?? "one-way",
    extras: f.extras,
    dryIcePounds: f.dryIcePounds?.toString() ?? "",
    pickupWait: f.pickupWaitMinutes?.toString() ?? "",
    deliveryWait: f.deliveryWaitMinutes?.toString() ?? "",
    deliveryAttempts: f.additionalDeliveryAttempts?.toString() ?? "",
    recoveryAttempts: f.airportRecoveryAttempts?.toString() ?? "",
    helper,
    helperHours: f.helperHours?.toString() ?? "",
    helperRate: "",
    vehicleAuto: !f.vehicleClass,
    capacityAuto: true,
    fuelAuto: true,
    weightAuto: f.weight === null && estimates.weight !== null,
    pickupAuto: !f.pickupStart,
    deliveryAuto: !f.deliveryEnd,
    driveMinutes: null,
  };
}

function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
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

function QuoteHeader({ summary }: { summary: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Quote request</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
          This email asks for a price
        </span>
      </div>
      {summary && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{summary}</p>}
    </>
  );
}

const cardSectionClass =
  "rounded-2xl border border-indigo-200 bg-white shadow-sm dark:border-indigo-900/70 dark:bg-zinc-900";

/** Stands in for the quote card while the email's attachments are read for its details. */
export function QuoteReadingDocuments({
  summary,
  documents,
  cardClass,
}: {
  summary: string;
  documents: string[];
  cardClass: string;
}) {
  return (
    <section className={`${cardSectionClass} ${cardClass}`} aria-busy="true">
      <QuoteHeader summary={summary} />
      <p className="mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600 dark:border-indigo-900 dark:border-t-indigo-400" />
        <span>
          Reading {documents.length === 1 ? "the attachment" : `${documents.length} attachments`} for the quote
          details: {documents.join(", ")}…
        </span>
      </p>
    </section>
  );
}

/**
 * Shown when the email open in Missive asks for a price quote. The details
 * the email states are filled in; the route miles and drive time come from
 * Google Maps; the fuel surcharge and what it applies to come from
 * Xcelerator's current surcharges for the vehicle; the vehicle, its
 * capacity, the weight and the times the email leaves out are worked out by
 * the sizing rules and the AI's estimate. All of it is listed so the CSR can
 * check it. Quote Engine's rate sheet prices it and the reply with that price
 * is drafted. Nothing is sent: the CSR puts the reply into Missive and sends
 * it there.
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
  const estimates = detection.estimates;
  const read = detection.read;
  // Fields taken from an earlier message or a document rather than the open email.
  const fromElsewhere = Object.entries(detection.fieldSources ?? {}).map(
    ([field, source]) => `${QUOTE_FIELD_LABELS[field as QuoteField]} (${source})`,
  );
  const [form, setForm] = useState<Form>(() => initialForm(detection));
  // Priced straight away once the fuel surcharge (and the miles, when they are
  // looked up) have come back and everything is filled in; otherwise the CSR
  // fills the gaps and presses Calculate.
  const [calc, setCalc] = useState<CalcState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const [insert, setInsert] = useState<InsertState>({ status: "idle" });
  // Miles are looked up straight away when the email names both places but no distance.
  const [milesLookup, setMilesLookup] = useState<MilesState>(() =>
    form.pickupAddress.trim() && form.deliveryAddress.trim() && !form.miles.trim()
      ? { status: "loading" }
      : { status: "idle" },
  );
  const [fuel, setFuel] = useState<FuelState>({ status: "loading" });
  // The per-vehicle fallback: built in, until the server sends its own (which can be set by env).
  const [fuelDefaults, setFuelDefaults] = useState<FuelSurchargeDefaults>(DEFAULT_FUEL_SURCHARGES);
  const seqRef = useRef(0);
  const milesSeqRef = useRef(0);
  // The form as it is now, for work that finishes after the CSR may have typed more.
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  // The lookups the first automatic pricing waits for.
  const autoRef = useRef({ miles: milesLookup.status === "loading", fuel: true, done: false });

  /** Prices the quote once every lookup started on opening has answered, if nothing is missing. */
  function settleAuto(which: "miles" | "fuel", next: Form) {
    const auto = autoRef.current;
    if (auto.done) return;
    auto[which] = false;
    if (auto.miles || auto.fuel) return;
    auto.done = true;
    if ("inputs" in buildInputs(next)) {
      setCalc({ status: "loading" });
      void runCalculation(next);
    }
  }

  /** Applies a change to the form now and to `formRef`, so a lookup answering right after sees it. */
  function applyNow(change: (prev: Form) => Form): Form {
    const next = change(formRef.current);
    formRef.current = next;
    setForm(change);
    return next;
  }

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
          route: {
            pickupAddress: current.pickupAddress.trim() || null,
            deliveryAddress: current.deliveryAddress.trim() || null,
          },
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
      setCalc({
        status: "ready",
        quote: data.quote,
        reply: data.reply,
        inputs: built.inputs,
        pickupAddress: current.pickupAddress.trim() || null,
        deliveryAddress: current.deliveryAddress.trim() || null,
        seq,
      });
    } catch {
      if (seq === seqRef.current) setCalc({ status: "error", message: "Network error. Try again." });
    }
  }

  /**
   * Fills route miles with Google Maps' driving distance between the pickup and
   * delivery places. `thenCalculate` is for the automatic lookup on opening:
   * the quote is priced once it (and the fuel lookup) answer, when nothing
   * else is missing. The caller shows the lookup as running.
   */
  async function lookUpMiles(current: Form, thenCalculate: boolean) {
    const from = current.pickupAddress.trim();
    const to = current.deliveryAddress.trim();
    if (!from || !to) return;
    const seq = ++milesSeqRef.current;
    try {
      const res = await fetch("/api/web-agent/quote/miles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = (await res.json().catch(() => null)) as
        | { miles?: number; minutes?: number | null; error?: string }
        | null;
      if (seq !== milesSeqRef.current) return;
      if (!res.ok || typeof data?.miles !== "number") {
        setMilesLookup({ status: "error", message: data?.error ?? `Google Maps error (${res.status})` });
        return;
      }
      const miles = String(data.miles);
      const minutes = typeof data.minutes === "number" ? data.minutes : null;
      setMilesLookup({ status: "ready", minutes });
      applyNow((prev) => ({
        ...prev,
        miles,
        driveMinutes: minutes,
        deliveryEnd: prev.deliveryAuto ? assumedDeliveryEnd(prev.pickupStart, minutes) : prev.deliveryEnd,
      }));
    } catch {
      if (seq === milesSeqRef.current) setMilesLookup({ status: "error", message: "Network error. Try again." });
    } finally {
      // With or without new miles, pricing on opening goes ahead if nothing is missing.
      if (thenCalculate) settleAuto("miles", formRef.current);
    }
  }

  /**
   * Fills the fuel surcharge % and what it applies to with Xcelerator's
   * current surcharge for the vehicle, unless the CSR has typed their own.
   * Without one, the default for the vehicle (from the server) is used.
   */
  async function lookUpFuel(current: Form) {
    let table: XceleratorFuelSurcharges | null = null;
    let defaults = fuelDefaults;
    try {
      const res = await fetch("/api/web-agent/quote/fuel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: email.from,
          pickupAddress: current.pickupAddress.trim() || null,
          deliveryAddress: current.deliveryAddress.trim() || null,
          day: current.deliveryEnd.slice(0, 10),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { fuel?: XceleratorFuelSurcharges | null; defaults?: unknown; reason?: string; error?: string }
        | null;
      if (isFuelDefaults(data?.defaults)) {
        defaults = data.defaults;
        setFuelDefaults(defaults);
      }
      table = res.ok ? (data?.fuel ?? null) : null;
      setFuel(
        table
          ? { status: "ready", table }
          : {
              status: "unavailable",
              message: res.ok
                ? (data?.reason ?? "Xcelerator has no fuel surcharge to use")
                : (data?.error ?? `Couldn't read the fuel surcharge from Xcelerator (${res.status})`),
            },
      );
    } catch {
      setFuel({ status: "unavailable", message: "Couldn't reach Xcelerator for the fuel surcharge" });
    }
    const next = applyNow((prev) => withFuel(prev, table, defaults));
    settleAuto("fuel", next);
  }

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void lookUpFuel(form);
    // Both only set state once their fetch answers, never synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (milesLookup.status === "loading") void lookUpMiles(form, true);
    // Runs once for the email this card was opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<Form>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  /** Xcelerator's (else the default) fuel surcharge for the form's vehicle, while the CSR hasn't typed their own. */
  function withFuel(prev: Form, table: XceleratorFuelSurcharges | null, defaults: FuelSurchargeDefaults): Form {
    const choice = prev.fuelAuto ? fuelChoice(prev.vehicleClass, table, defaults) : null;
    return choice ? { ...prev, fuelPercent: String(choice.entry.percent), fuelBasis: choice.entry.basis } : prev;
  }

  /** The form with another vehicle: its capacity follows, and the fuel surcharge unless typed on this card. */
  function withVehicle(prev: Form, vehicleClass: VehicleClass | ""): Form {
    const next: Form = {
      ...prev,
      vehicleClass,
      capacity: vehicleClass ? capacityFor(vehicleClass) : "",
      capacityAuto: true,
    };
    return withFuel(next, fuel.status === "ready" ? fuel.table : null, fuelDefaults);
  }

  function changePlace(patch: Pick<Partial<Form>, "pickupAddress" | "deliveryAddress">) {
    update(patch);
    // Miles fetched for the old places no longer apply; a lookup still running is dropped.
    milesSeqRef.current += 1;
    setMilesLookup({ status: "idle" });
  }

  function sizingLoad(weight: number | null, extras: QuoteExtra[], helper: boolean): LoadForSizing {
    return { weight, pallets: fields.pallets, truckItem: estimates.truckItem, extras, helper };
  }

  function toggleHelper(helper: boolean) {
    setForm((prev) => {
      const next: Form = { ...prev, helper };
      // A vehicle the sizing rules picked follows: a second person needs a box truck.
      if (!prev.vehicleAuto) return next;
      const { vehicleClass } = pickVehicle(sizingLoad(num(prev.weight), prev.extras, helper));
      return vehicleClass !== prev.vehicleClass ? withVehicle(next, vehicleClass) : next;
    });
  }

  function changeVehicle(vehicleClass: VehicleClass | "") {
    setForm((prev) => withVehicle({ ...prev, vehicleAuto: false }, vehicleClass));
  }

  function changeWeight(weight: string) {
    setForm((prev) => {
      const next: Form = { ...prev, weight, weightAuto: false };
      // A vehicle the sizing rules picked is re-sized for the new weight.
      if (!prev.vehicleAuto) return next;
      const { vehicleClass } = pickVehicle(sizingLoad(num(weight), prev.extras, prev.helper));
      return vehicleClass !== prev.vehicleClass ? withVehicle(next, vehicleClass) : next;
    });
  }

  function changePickupStart(pickupStart: string) {
    setForm((prev) => ({
      ...prev,
      pickupStart,
      pickupAuto: false,
      deliveryEnd: prev.deliveryAuto ? assumedDeliveryEnd(pickupStart, prev.driveMinutes) : prev.deliveryEnd,
    }));
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
    !fields.pickupAddress && "pickup place",
    !fields.deliveryAddress && "delivery place",
    !fields.miles && !(fields.pickupAddress && fields.deliveryAddress) && "route miles",
    !fields.weight && estimates.weight === null && "weight",
  ].filter((v): v is string => Boolean(v));

  // What was worked out rather than read from the email, while it still stands.
  const weightNow = num(form.weight);
  const capacityNow = num(form.capacity);
  const overCapacity = !boxTruck && weightNow !== null && capacityNow !== null && weightNow > capacityNow;
  const sized = pickVehicle(sizingLoad(weightNow, form.extras, form.helper));
  const freeWait = boxTruck ? 60 : 15;
  const vehicleWhy = sized.vehicleClass === form.vehicleClass ? sized.reason : "by the sizing rules";
  const deliveryMinutes = Math.max(120, (form.driveMinutes ?? 0) + 60);
  const vehicleName = form.vehicleClass ? VEHICLE_LABELS[form.vehicleClass].toLowerCase() : "";
  // The surcharge the card would use for this vehicle (Xcelerator's, else the
  // default), and whether the fields still hold it.
  const fuelSuggested = fuelChoice(form.vehicleClass, fuel.status === "ready" ? fuel.table : null, fuelDefaults);
  const fuelInUse =
    fuelSuggested &&
    form.fuelPercent.trim() !== "" &&
    Number(form.fuelPercent) === fuelSuggested.entry.percent &&
    form.fuelBasis === fuelSuggested.entry.basis
      ? fuelSuggested
      : null;
  const fuelFromXcelerator = fuelInUse?.fromXcelerator ? fuelInUse.entry : null;
  const fuelFromDefault = fuelInUse && !fuelInUse.fromXcelerator ? fuelInUse.entry : null;
  // Why the default is used rather than Xcelerator's.
  const fuelDefaultWhy =
    fuel.status === "loading"
      ? "until Xcelerator's current one comes back"
      : fuel.status === "unavailable"
        ? fuel.message.replace(/\.+$/, "")
        : `Xcelerator has none for a ${vehicleName}`;
  const basisText = (basis: FuelBasis) => (basis === "transport" ? "the transport charge" : "all charges");
  const capacityText =
    form.capacityAuto && form.vehicleClass
      ? boxTruck
        ? "Capacity: 9,000 lb, fixed by the rate sheet for a box truck"
        : form.capacity === String(VEHICLE_CAPACITY_LB[form.vehicleClass])
          ? `Capacity: ${VEHICLE_CAPACITY_LB[form.vehicleClass].toLocaleString("en-US")} lb, standard for a ${vehicleName}`
          : capacityNow !== null && `Capacity: ${capacityNow.toLocaleString("en-US")} lb, the figure saved in this browser for a ${vehicleName}`
      : null;
  const workedOut = [
    form.vehicleAuto && form.vehicleClass && `Vehicle: ${VEHICLE_LABELS[form.vehicleClass]} (${vehicleWhy})`,
    form.weightAuto &&
      `Weight: about ${Number(form.weight).toLocaleString("en-US")} lb${estimates.weightReason ? ` (${estimates.weightReason})` : ""}`,
    capacityText,
    fuelFromXcelerator &&
      `Fuel surcharge: ${fuelFromXcelerator.percent}% of ${basisText(fuelFromXcelerator.basis)}, Xcelerator's current "${fuelFromXcelerator.name}" for a ${vehicleName}`,
    fuelFromDefault &&
      fuel.status !== "loading" &&
      `Fuel surcharge: ${fuelFromDefault.percent}% of ${basisText(fuelFromDefault.basis)}, the default "${fuelFromDefault.name}" for a ${vehicleName} (${fuelDefaultWhy}); check it's still current`,
    form.pickupAuto && "Pickup: now (no upcoming pickup time in the email)",
    form.deliveryAuto &&
      `Delivery by: ${durationText(deliveryMinutes)} after pickup (${form.driveMinutes !== null ? `the ${durationText(form.driveMinutes)} drive plus an hour` : "at least two hours"})`,
  ].filter((v): v is string => Boolean(v));
  const fuelHint =
    fuel.status === "loading"
      ? "Getting the current one from Xcelerator…"
      : fuelFromXcelerator
        ? `From Xcelerator ("${fuelFromXcelerator.name}")`
        : fuelFromDefault
          ? `Default for a ${vehicleName}: ${fuelDefaultWhy}`
          : // Typed on this card; the link below the field offers the suggested one back.
            fuel.status === "unavailable"
            ? fuel.message
            : undefined;
  const placesSet = Boolean(form.pickupAddress.trim() && form.deliveryAddress.trim());
  const directionsUrl = placesSet
    ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(routeAddress(form.pickupAddress))}&destination=${encodeURIComponent(routeAddress(form.deliveryAddress))}`
    : null;

  return (
    <section id="quote-request" className={`${cardSectionClass} ${cardClass}`}>
      <QuoteHeader summary={detection.summary} />

      {read && (read.threadMessages > 0 || read.documents.length > 0) && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Read from: this email
          {read.threadMessages > 0 &&
            `, ${read.threadMessages} earlier message${read.threadMessages === 1 ? "" : "s"} in the thread`}
          {read.documents.length > 0 && `, ${read.documents.join(", ")}`}.
        </p>
      )}
      {fromElsewhere.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Taken from the thread and attachments: {fromElsewhere.join(" · ")}.
        </p>
      )}
      {read && read.skipped.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Not read: {read.skipped.map((s) => `${s.name} (${s.why})`).join("; ")}.
        </p>
      )}
      {read?.documentsUnavailable && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{read.documentsUnavailable}</p>
      )}

      {(fields.pieces || fields.pallets) && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {[fields.pieces && `Pieces: ${fields.pieces}`, fields.pallets && `Pallets: ${fields.pallets}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {detection.unreadReason && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-300">
          {detection.unreadReason}
        </p>
      )}

      {!detection.unreadReason && notInEmail.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Not in the email{read?.documents.length ? " or its attachments" : ""}: {notInEmail.join(", ")}.
        </p>
      )}

      {workedOut.length > 0 && (
        <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200">
          <p className="font-medium">Worked out for you (check before you send it):</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {workedOut.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Pickup from">
            <input
              type="text"
              value={form.pickupAddress}
              onChange={(e) => changePlace({ pickupAddress: e.target.value })}
              placeholder="Business name or address"
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Deliver to">
            <input
              type="text"
              value={form.deliveryAddress}
              onChange={(e) => changePlace({ deliveryAddress: e.target.value })}
              placeholder="Business name or address"
              className={inputClass}
            />
          </Labeled>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Labeled label="Vehicle" hint={form.vehicleClass ? VEHICLE_SHEET_NOTES[form.vehicleClass] : undefined}>
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
            <button
              type="button"
              onClick={() => {
                setMilesLookup({ status: "loading" });
                void lookUpMiles(form, false);
              }}
              disabled={!placesSet || milesLookup.status === "loading"}
              title={placesSet ? "Driving miles between the two places, from Google Maps" : "Enter the pickup and delivery places first"}
              className="self-start text-xs font-medium text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 disabled:no-underline dark:text-indigo-400 dark:disabled:text-zinc-500"
            >
              {milesLookup.status === "loading" ? "Getting miles from Google Maps…" : "Get miles from Google Maps"}
            </button>
            {milesLookup.status === "ready" && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                From Google Maps{milesLookup.minutes !== null && ` · about ${milesLookup.minutes} min drive`}
              </span>
            )}
            {milesLookup.status === "error" && (
              <span className="text-xs text-red-600 dark:text-red-400">{milesLookup.message}</span>
            )}
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
              onChange={(e) => changeWeight(e.target.value)}
              className={inputClass}
            />
          </Labeled>
          <Labeled
            label="Vehicle capacity (lb)"
            hint={
              boxTruck
                ? "Box truck: fixed at 9,000 lb"
                : overCapacity
                  ? "The weight is over this capacity: pick a bigger vehicle"
                  : undefined
            }
          >
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              disabled={boxTruck}
              value={boxTruck ? "9000" : form.capacity}
              onChange={(e) => update({ capacity: e.target.value, capacityAuto: false })}
              aria-invalid={overCapacity}
              className={`${inputClass} disabled:opacity-60`}
            />
          </Labeled>
          <Labeled label="Pickup start (Atlanta)">
            <input
              type="datetime-local"
              value={form.pickupStart}
              onChange={(e) => changePickupStart(e.target.value)}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Delivery by (Atlanta)">
            <input
              type="datetime-local"
              value={form.deliveryEnd}
              onChange={(e) => update({ deliveryEnd: e.target.value, deliveryAuto: false })}
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Fuel surcharge %" hint={fuelHint}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.fuelPercent}
              onChange={(e) => update({ fuelPercent: e.target.value, fuelAuto: false })}
              placeholder={fuel.status === "loading" ? "From Xcelerator…" : undefined}
              className={inputClass}
            />
            {fuelSuggested && !fuelInUse && (
              <button
                type="button"
                onClick={() =>
                  update({
                    fuelPercent: String(fuelSuggested.entry.percent),
                    fuelBasis: fuelSuggested.entry.basis,
                    fuelAuto: true,
                  })
                }
                className="self-start text-left text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {fuelSuggested.fromXcelerator ? "Use Xcelerator's current" : "Use the default"}{" "}
                {fuelSuggested.entry.percent}% of {basisText(fuelSuggested.entry.basis)} (&quot;
                {fuelSuggested.entry.name}&quot;)
              </button>
            )}
          </Labeled>
          <Labeled
            label="Fuel surcharge on"
            hint={
              fuelFromXcelerator
                ? "As Xcelerator applies it"
                : fuelFromDefault
                  ? "As Xcelerator applies it (default)"
                  : undefined
            }
          >
            <select
              value={form.fuelBasis}
              onChange={(e) => update({ fuelBasis: e.target.value as FuelBasis | "", fuelAuto: false })}
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
          <label className="inline-flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={form.helper}
              onChange={(e) => toggleHelper(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-indigo-600 dark:border-zinc-700"
            />
            Second person (helper)
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Labeled label="Wait at pickup (min)" hint={`${freeWait} min free`}>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={form.pickupWait}
              onChange={(e) => update({ pickupWait: e.target.value })}
              placeholder="0"
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Wait at delivery (min)" hint={`${freeWait} min free`}>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={form.deliveryWait}
              onChange={(e) => update({ deliveryWait: e.target.value })}
              placeholder="0"
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Extra delivery attempts" hint="Each one is the base price again">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={form.deliveryAttempts}
              onChange={(e) => update({ deliveryAttempts: e.target.value })}
              placeholder="0"
              className={inputClass}
            />
          </Labeled>
          <Labeled label="Airport recovery attempts" hint="$18.00 each">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={form.recoveryAttempts}
              onChange={(e) => update({ recoveryAttempts: e.target.value })}
              placeholder="0"
              className={inputClass}
            />
          </Labeled>
          {form.helper && (
            <>
              <Labeled label="Helper hours">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.25"
                  value={form.helperHours}
                  onChange={(e) => update({ helperHours: e.target.value })}
                  className={inputClass}
                />
              </Labeled>
              <Labeled label="Helper $ per hour" hint="Priced by quote only on the sheet">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.helperRate}
                  onChange={(e) => update({ helperRate: e.target.value })}
                  className={inputClass}
                />
              </Labeled>
            </>
          )}
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
          {fuel.status === "loading" && calc.status === "idle" ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Getting the fuel surcharge from Xcelerator…</span>
          ) : (
            missing.length > 0 && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Still needed: {missing.join(", ")}.</span>
            )
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

          <XceleratorQuoteSave
            key={calc.seq}
            inputs={calc.inputs}
            pickupAddress={calc.pickupAddress}
            deliveryAddress={calc.deliveryAddress}
            pieces={fields.pieces}
            pallets={fields.pallets}
            senderEmail={email.from}
            callerName={email.fromName || email.from}
          />
        </div>
      )}
    </section>
  );
}
