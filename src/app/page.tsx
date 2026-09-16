"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { OrderInquiry, OrderLookupSource } from "@/lib/xcelerator";
import { buildSuggestedReply } from "@/lib/email";
import { detectOrderReferences, type DetectedReference } from "@/lib/reference-detection";
import { MissiveEmailSense, type MissiveSenseStatus } from "@/components/MissiveEmailSense";

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "success";
      order: OrderInquiry;
      source: OrderLookupSource;
    };

type ReplyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string };

const SAMPLE_REFS = ["REF-1001", "REF-1002", "REF-1003", "REF-1004"];

function formatMaybeDate(value: string | null): string {
  if (!value) return "TBD";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "TBD" : date.toLocaleString();
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M17 17l-3.8-3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 10.2l3.2 3.2L15 6.6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6.2v3.8l2.4 1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="7.25" y="7.25" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.25 12.5v-7a1.5 1.5 0 0 1 1.5-1.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="2.75" y="4.75" width="14.5" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.25 5.5l6.75 5 6.75-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type BadgeTone = "emerald" | "amber" | "zinc" | "indigo";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300",
  zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300",
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

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

function formatFullAddress(
  street: string | null,
  street2: string | null,
  location: string,
  zip: string | null,
): string | null {
  const lines = [street, street2].filter(Boolean).join(", ");
  const cityStateZip = [location, zip].filter(Boolean).join(" ");
  const combined = [lines, cityStateZip].filter(Boolean).join(", ");
  return combined || null;
}

function formatContact(contact: string | null, phone: string | null, email: string | null): string | null {
  return [contact, phone, email].filter(Boolean).join(" · ") || null;
}

function formatWeight(value: number | null): string | null {
  if (value === null || value === 0) return null;
  return `${value} lb`;
}

function formatDims(pkg: { length: number | null; width: number | null; height: number | null }): string | null {
  if (pkg.length === null || pkg.width === null || pkg.height === null) return null;
  return `${pkg.length} x ${pkg.width} x ${pkg.height} in`;
}

function StatusRow({
  label,
  answer,
  positive,
}: {
  label: string;
  answer: string;
  positive: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          positive
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300"
            : "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"
        }`}
      >
        {positive ? <CheckIcon className="h-3.5 w-3.5" /> : <ClockIcon className="h-3.5 w-3.5" />}
      </span>
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
        <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{answer}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const [referenceNumber, setReferenceNumber] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [reply, setReply] = useState<ReplyState>({ status: "idle" });

  // Order/reference detection: the primary source is MissiveEmailSense
  // below, which senses whichever email the CSR currently has open in
  // Missive. "Paste an email instead" is a manual fallback for when this
  // page isn't embedded in Missive (or Missive isn't configured) — either
  // path only ever fills the search box, it never submits the lookup itself.
  const [showEmailPanel, setShowEmailPanel] = useState(false);
  const [emailText, setEmailText] = useState("");
  const [detectedRefs, setDetectedRefs] = useState<DetectedReference[]>([]);
  // Tracks the value we last auto-filled so re-detecting doesn't fight a
  // value the CSR has since edited by hand in the search box.
  const lastAutoFilledRef = useRef<string | null>(null);
  // Auto-opens the paste fallback once, the first time we learn Missive
  // sensing isn't available — never re-opens it if the CSR then hides it.
  const autoOpenedPasteRef = useRef(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setLive(Boolean(data.live));
        setAiDrafting(Boolean(data.aiDrafting));
      })
      .catch(() => setLive(false));
  }, []);

  async function handleLookup(refOverride?: string) {
    const ref = (refOverride ?? referenceNumber).trim();
    if (!ref) return;

    setReferenceNumber(ref);
    setState({ status: "loading" });
    setReply({ status: "idle" });
    setCopied(false);

    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(ref)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setState({
          status: "error",
          message: body?.error ?? `Lookup failed (${res.status})`,
        });
        return;
      }
      const body: { order: OrderInquiry; source: OrderLookupSource } = await res.json();
      setState({
        status: "success",
        order: body.order,
        source: body.source,
      });
      loadReplyForOrder(body.order);
    } catch {
      setState({ status: "error", message: "Network error — please try again." });
    }
  }

  async function loadReplyForOrder(order: OrderInquiry) {
    setReply({ status: "loading" });

    try {
      const res = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceNumber: order.referenceNumber }),
      });
      const data = await res.json().catch(() => null);
      setReply({ status: "ready", text: data?.reply ?? buildSuggestedReply(order) });
    } catch {
      setReply({ status: "ready", text: buildSuggestedReply(order) });
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied — nothing to do
    }
  }

  // Shared by both detection sources (Missive-sensed text and the manual
  // paste fallback): scans the text and, when a new top candidate shows up,
  // drops it into the search box — but only ever sets state, never calls
  // handleLookup. The search box stays a normal controlled input, so the
  // CSR can freely retype or correct it afterward.
  function applyDetectedText(text: string) {
    const detected = detectOrderReferences(text);
    setDetectedRefs(detected);

    const top = detected[0];
    if (top && top.value !== lastAutoFilledRef.current) {
      lastAutoFilledRef.current = top.value;
      setReferenceNumber(top.value);
    }
  }

  function handleEmailTextChange(value: string) {
    setEmailText(value);
    applyDetectedText(value);
  }

  // Called by MissiveEmailSense whenever the CSR opens a different email in
  // Missive. Mirrors the pasted text into the same textarea (so expanding
  // the fallback panel shows exactly what was scanned, and can be
  // hand-corrected) and runs the same detection path.
  function handleMissiveEmailText(text: string) {
    setEmailText(text);
    applyDetectedText(text);
  }

  function handleMissiveStatusChange(status: MissiveSenseStatus) {
    if (!autoOpenedPasteRef.current && (status === "not-embedded" || status === "not-configured")) {
      autoOpenedPasteRef.current = true;
      setShowEmailPanel(true);
    }
  }

  // Lets the CSR pick a different detected candidate (when the top guess
  // wasn't the right one) without touching the email text itself.
  function applyDetectedReference(value: string) {
    lastAutoFilledRef.current = value;
    setReferenceNumber(value);
  }

  function clearEmailPanel() {
    setEmailText("");
    setDetectedRefs([]);
    lastAutoFilledRef.current = null;
  }

  const order = state.status === "success" ? state.order : null;
  const lookupSource = state.status === "success" ? state.source : null;

  return (
    <div className="flex flex-1 flex-col bg-gradient-to-b from-zinc-50 to-white font-sans dark:from-zinc-950 dark:to-zinc-900">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-base font-bold text-white shadow-sm dark:from-indigo-400 dark:to-indigo-600">
              X
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  Xcelerator Query Brain
                </h1>
                {live !== null && <Badge tone={live ? "emerald" : "zinc"}>{live ? "Live Xcelerator" : "Mock data"}</Badge>}
              </div>
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                Pull pickup, delivery, POD, and charge status straight from Xcelerator.
              </p>
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900 sm:p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLookup();
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Reference or order ID, e.g. REF-1003 or 105.081826"
                className="w-full rounded-xl border border-zinc-300 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 outline-none transition-shadow focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-400"
              />
            </div>
            <button
              type="submit"
              disabled={state.status === "loading" || !referenceNumber.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
            >
              {state.status === "loading" ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Looking up…
                </>
              ) : (
                <>
                  <SearchIcon className="h-4 w-4" />
                  Look up
                </>
              )}
            </button>
          </form>

          <div className="mt-3 flex flex-col gap-2">
            {/* Primary path: senses whichever email is open in Missive and
                fills the search box above automatically — no paste needed. */}
            <MissiveEmailSense onEmailText={handleMissiveEmailText} onStatusChange={handleMissiveStatusChange} />

            {detectedRefs.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Detected:</span>
                {detectedRefs.map((ref) => (
                  <button
                    key={ref.value}
                    type="button"
                    title={ref.reason}
                    onClick={() => applyDetectedReference(ref.value)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      referenceNumber === ref.value
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300"
                        : "border-zinc-300 text-zinc-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-indigo-500 dark:hover:text-indigo-400"
                    }`}
                  >
                    {ref.value}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowEmailPanel((prev) => !prev)}
              className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-400"
            >
              <MailIcon className="h-3.5 w-3.5" />
              {showEmailPanel ? "Hide pasted email" : "Paste an email instead"}
            </button>

            {showEmailPanel && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                <textarea
                  value={emailText}
                  onChange={(e) => handleEmailTextChange(e.target.value)}
                  placeholder="Paste the customer's email here — we'll scan it for an order or reference number and fill in the search box above. You can still edit the search box before looking it up."
                  rows={5}
                  className="w-full resize-y rounded-lg border border-zinc-300 bg-white p-2.5 text-xs leading-relaxed text-zinc-800 outline-none transition-shadow focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {detectedRefs.length === 0 &&
                    (emailText.trim() ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        No order or reference number detected — you can still type one into the search box above.
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">Nothing pasted yet.</span>
                    ))}
                  {emailText && (
                    <button
                      type="button"
                      onClick={clearEmailPanel}
                      className="ml-auto text-xs font-medium text-zinc-400 hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {live === false && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span>Sample refs (mock data):</span>
              {SAMPLE_REFS.map((ref) => (
                <button
                  key={ref}
                  onClick={() => handleLookup(ref)}
                  className="rounded-full border border-zinc-300 px-2.5 py-1 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-zinc-700 dark:hover:border-indigo-500 dark:hover:text-indigo-400"
                >
                  {ref}
                </button>
              ))}
            </div>
          )}
        </section>

        {state.status === "error" && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300">
            {state.message}
          </p>
        )}

        {state.status === "idle" && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-6 py-16 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
              <SearchIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Look up an order to get started
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                Enter a reference number or Xcelerator tracking ID above to see pickup,
                delivery, POD, and charge status.
              </p>
            </div>
          </div>
        )}

        {state.status === "loading" && (
          <div className="animate-pulse rounded-2xl border border-zinc-200/70 bg-white p-6 dark:border-zinc-800/70 dark:bg-zinc-900">
            <div className="h-4 w-56 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-6 space-y-4">
              <div className="h-3 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-3 w-5/6 rounded-full bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-3 w-2/3 rounded-full bg-zinc-100 dark:bg-zinc-800" />
            </div>
          </div>
        )}

        {order && (
          <div className="flex flex-col gap-6">
            <section className="rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    {order.referenceNumber}
                  </h2>
                  {lookupSource && (
                    <Badge tone={lookupSource === "axis" ? "emerald" : lookupSource === "portal" ? "amber" : "zinc"}>
                      {lookupSource === "axis"
                        ? "Source: Axis API"
                        : lookupSource === "portal"
                          ? "Source: ClientPortal fallback"
                          : "Source: Mock data"}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Carrier: {order.carrier}</span>
              </div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{order.customer}</p>
              <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                <StatusRow
                  label="Has the driver arrived at pickup?"
                  positive={order.pickup.arrived}
                  answer={
                    order.pickup.arrived
                      ? `Yes — arrived at ${order.pickup.location} on ${formatMaybeDate(order.pickup.arrivedAt)}`
                      : `Not yet — scheduled for ${formatMaybeDate(order.pickup.scheduledAt)} at ${order.pickup.location}`
                  }
                />
                <StatusRow
                  label="Has this order been delivered?"
                  positive={order.delivery.delivered}
                  answer={
                    order.delivery.delivered
                      ? `Yes — delivered to ${order.delivery.location} on ${formatMaybeDate(order.delivery.deliveredAt)}`
                      : `Not yet — scheduled for ${formatMaybeDate(order.delivery.scheduledAt)} at ${order.delivery.location}`
                  }
                />
                <div className="flex items-start gap-3 py-3.5">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      order.pod.available
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"
                    }`}
                  >
                    {order.pod.available ? (
                      <CheckIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ClockIcon className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">POD information</p>
                    {order.pod.available ? (
                      <>
                        <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                          {order.pod.receivedBy ? `Signed by ${order.pod.receivedBy}` : "Signature on file"}
                        </p>
                        {order.pod.documentUrl?.startsWith("http") && (
                          <a
                            href={order.pod.documentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-block text-sm text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500 dark:text-indigo-400"
                          >
                            View POD document
                          </a>
                        )}
                        {order.pod.documentUrl?.startsWith("data:") && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={order.pod.documentUrl}
                            alt="POD signature"
                            className="mt-2 h-16 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800"
                          />
                        )}
                      </>
                    ) : (
                      <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">Not yet available</p>
                    )}
                  </div>
                </div>
                <StatusRow
                  label="Final charges"
                  positive={order.charges.finalized}
                  answer={
                    order.charges.finalized
                      ? new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: order.charges.currency,
                        }).format(order.charges.total)
                      : "Still being finalized"
                  }
                />
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Shipment details</h2>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Reference 2" value={order.referenceNumber2} />
                <Field label="Reference 3" value={order.referenceNumber3} />
                <Field label="Reference 4" value={order.referenceNumber4} />
                <Field label="Invoice #" value={order.invoiceNumber} />
                <Field label="Order type" value={order.orderType} />
                <Field label="Service" value={order.service} />
                <Field label="Vehicle" value={order.vehicle} />
                <Field label="Third-party tracking #" value={order.thirdPartyTrackingRefNo} />
              </div>

              {(order.caller.name || order.caller.department || order.caller.phone || order.caller.email) && (
                <div className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-3">
                  <Field label="Called in by" value={order.caller.name} />
                  <Field label="Department" value={order.caller.department} />
                  <Field
                    label="Caller contact"
                    value={formatContact(null, order.caller.phone, order.caller.email)}
                  />
                </div>
              )}

              <div className="mt-5 grid gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-2">
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    Shipper
                  </p>
                  <Field label="Company" value={order.pickup.company} />
                  <Field
                    label="Address"
                    value={formatFullAddress(
                      order.pickup.street,
                      order.pickup.street2,
                      order.pickup.location,
                      order.pickup.zip,
                    )}
                  />
                  <Field
                    label="Contact"
                    value={formatContact(order.pickup.contact, order.pickup.phone, order.pickup.email)}
                  />
                  <Field label="Target window" value={formatMaybeDate(order.pickup.scheduledTo)} />
                  <Field label="Departed" value={formatMaybeDate(order.pickup.departedAt)} />
                  <Field label="Special instructions" value={order.pickup.specialInstructions} />
                </div>
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    Consignee
                  </p>
                  <Field label="Company" value={order.delivery.company} />
                  <Field
                    label="Address"
                    value={formatFullAddress(
                      order.delivery.street,
                      order.delivery.street2,
                      order.delivery.location,
                      order.delivery.zip,
                    )}
                  />
                  <Field
                    label="Contact"
                    value={formatContact(order.delivery.contact, order.delivery.phone, order.delivery.email)}
                  />
                  <Field label="Target window" value={formatMaybeDate(order.delivery.scheduledTo)} />
                  <Field label="Departed" value={formatMaybeDate(order.delivery.departedAt)} />
                  <Field label="Special instructions" value={order.delivery.specialInstructions} />
                </div>
              </div>

              {(order.shipment.pieces || order.shipment.weight || order.shipment.declaredValue) && (
                <div className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-3">
                  <Field label="Pieces" value={order.shipment.pieces} />
                  <Field label="Total weight" value={formatWeight(order.shipment.weight)} />
                  <Field
                    label="Declared value"
                    value={
                      order.shipment.declaredValue
                        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                            order.shipment.declaredValue,
                          )
                        : null
                    }
                  />
                </div>
              )}

              {order.shipment.packages.length > 0 && (
                <div className="mt-5 overflow-x-auto border-t border-zinc-100 pt-4 dark:border-zinc-800">
                  <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                    <thead className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
                      <tr>
                        <th className="py-1 pr-4 font-medium">Package</th>
                        <th className="py-1 pr-4 font-medium">Ref #</th>
                        <th className="py-1 pr-4 font-medium">Weight</th>
                        <th className="py-1 font-medium">Dimensions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {order.shipment.packages.map((pkg, i) => (
                        <tr key={pkg.refNo ?? i}>
                          <td className="py-2 pr-4 text-zinc-800 dark:text-zinc-200">{pkg.name ?? "—"}</td>
                          <td className="py-2 pr-4 text-zinc-800 dark:text-zinc-200">{pkg.refNo ?? "—"}</td>
                          <td className="py-2 pr-4 text-zinc-800 dark:text-zinc-200">
                            {formatWeight(pkg.weight) ?? "—"}
                          </td>
                          <td className="py-2 text-zinc-800 dark:text-zinc-200">{formatDims(pkg) ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(order.cod.amount || order.specialInstructions || order.documents.length > 0) && (
                <div className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-3">
                  <Field
                    label="COD"
                    value={
                      order.cod.amount
                        ? `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(order.cod.amount)}${order.cod.location ? ` (${order.cod.location})` : ""}`
                        : null
                    }
                  />
                  <Field label="Order-level instructions" value={order.specialInstructions} />
                  <Field
                    label="Documents"
                    value={
                      order.documents.length > 0
                        ? order.documents.map((doc) => doc.name ?? doc.fileFormat ?? "file").join(", ")
                        : null
                    }
                  />
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">AI-suggested reply</h2>
                  <Badge tone={aiDrafting ? "indigo" : "zinc"}>{aiDrafting ? "GPT-drafted" : "Template"}</Badge>
                </div>
                <button
                  onClick={() => handleCopy(reply.status === "ready" ? reply.text : "")}
                  disabled={reply.status !== "ready"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <textarea
                readOnly
                value={reply.status === "ready" ? reply.text : "Drafting reply…"}
                rows={10}
                className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
              />
            </section>

          </div>
        )}
      </main>
    </div>
  );
}
