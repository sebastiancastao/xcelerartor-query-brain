"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { InquiryEmail } from "@/lib/agent";
import { MissiveEmailSense, isMissiveHost, type MissiveSenseStatus } from "@/components/MissiveEmailSense";
import { QuoteReadingDocuments, QuoteRequest } from "@/components/QuoteRequest";
import { useQuoteDetection } from "@/components/useQuoteDetection";
import { useEmbedded } from "@/components/useEmbedded";
import { NO_ESTIMATES, type QuoteRequestDetection } from "@/lib/quote-types";

/** A card with nothing filled in, for a quote the CSR enters by hand. */
const BLANK_DETECTION: QuoteRequestDetection = {
  isQuoteRequest: true,
  summary: "",
  fields: {
    vehicleClass: null,
    miles: null,
    weight: null,
    pieces: null,
    pallets: null,
    pickupAddress: null,
    deliveryAddress: null,
    pickupStart: null,
    deliveryEnd: null,
    trip: null,
    extras: [],
    dryIcePounds: null,
    pickupWaitMinutes: null,
    deliveryWaitMinutes: null,
    additionalDeliveryAttempts: null,
    airportRecoveryAttempts: null,
    helperHours: null,
    needsHelper: false,
    fuelPercent: null,
    fuelBasis: null,
  },
  estimates: NO_ESTIMATES,
};

const NO_EMAIL: InquiryEmail = { subject: "", from: "", body: "" };

function TagIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.5 10.6V4.75c0-.69.56-1.25 1.25-1.25h5.85c.33 0 .65.13.88.37l4.65 4.65a1.25 1.25 0 0 1 0 1.77l-5.85 5.85a1.25 1.25 0 0 1-1.77 0L3.87 11.5a1.25 1.25 0 0 1-.37-.9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="7.25" cy="7.25" r="1.25" fill="currentColor" />
    </svg>
  );
}

const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400";
const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
const inputClass =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-shadow focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-400";

/**
 * The quoting tool on its own page, for a Missive sidebar of its own: it
 * senses the email open in Missive like /web-agent does, but only checks it
 * for a price-quote request and prices it on the rate sheet (no order
 * lookup). Outside Missive a quote email can be pasted in, and a blank
 * quote can be started either way. Nothing is sent from here.
 */
export default function QuoteAgentHome() {
  const embedded = useEmbedded();
  const card = embedded ? "p-4" : "p-6";
  const quote = useQuoteDetection();
  const [missiveHost, setMissiveHost] = useState(false);
  // Whether the page can sense emails; without Missive the paste box shows.
  const [senseStatus, setSenseStatus] = useState<MissiveSenseStatus>("loading-script");
  // The email open in Missive, so a blank quote still answers it.
  const openEmailRef = useRef<{ email: InquiryEmail; conversationId: string | null } | null>(null);
  const [pasted, setPasted] = useState({ from: "", body: "" });

  function handleMissiveEmailText(
    _text: string,
    meta: { subject: string; from: string; fromName: string; body: string; conversationId: string },
  ) {
    const email = { subject: meta.subject, from: meta.from, fromName: meta.fromName, body: meta.body };
    const conversationId = meta.conversationId || null;
    openEmailRef.current = { email, conversationId };
    void quote.check(email, conversationId);
  }

  function handlePastedSubmit() {
    const body = pasted.body.trim();
    if (!body) return;
    // A first line "Subject: …" (as a forwarded email's header has) is taken as the subject.
    const firstLine = body.split("\n", 1)[0].trim();
    const subject = /^subject:/i.test(firstLine) ? firstLine.replace(/^subject:\s*/i, "") : "";
    void quote.check({ subject, from: pasted.from.trim(), body }, null);
  }

  function startBlankQuote() {
    quote.show(openEmailRef.current?.email ?? NO_EMAIL, BLANK_DETECTION);
  }

  const s = quote.state;
  // missive.js sets up window.Missive on any page, so outside Missive the
  // sense stays "waiting"; a page that isn't framed (and that Missive hasn't
  // initialized) is open on its own, and gets the paste box instead.
  const canPaste =
    !missiveHost && (!embedded || senseStatus === "not-embedded" || senseStatus === "not-configured");
  const busy = s.status === "checking" || s.status === "reading-documents";

  return (
    <div className="flex flex-1 flex-col bg-gradient-to-b from-zinc-50 to-white font-sans dark:from-zinc-950 dark:to-zinc-900">
      <main
        className={`mx-auto flex w-full max-w-3xl flex-1 flex-col ${embedded ? "gap-4 px-3 py-3" : "gap-8 px-6 py-10"}`}
      >
        <header className="flex flex-wrap items-center gap-3">
          <div
            className={`flex ${embedded ? "h-8 w-8" : "h-10 w-10"} shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-sm dark:from-indigo-400 dark:to-indigo-600`}
          >
            <TagIcon className={embedded ? "h-4 w-4" : "h-5 w-5"} />
          </div>
          <div className="min-w-0">
            <h1 className={`${embedded ? "text-base" : "text-xl"} font-semibold tracking-tight text-zinc-900 dark:text-zinc-50`}>
              Xcelerator Quote Agent
            </h1>
            {!embedded && (
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                Reads quote requests from Missive, prices them on the rate sheet and drafts the reply.
              </p>
            )}
          </div>
          {!embedded && (
            <Link
              href="/web-agent"
              className="ml-auto text-xs font-medium text-zinc-400 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
            >
              Order lookup
            </Link>
          )}
        </header>

        <section className="flex flex-col gap-3 rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canPaste && (
              <p className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                Not opened inside Missive — paste a quote email below, or start a blank quote.
              </p>
            )}
            {/* Still mounted outside Missive (it loads missive.js), just not shown. */}
            <div className={canPaste ? "hidden" : "contents"}>
            <MissiveEmailSense
              purpose="quote"
              onEmailText={handleMissiveEmailText}
              onStatusChange={(status) => {
                setSenseStatus(status);
                // Missive sets its id on init, before it reports an open email.
                setMissiveHost(isMissiveHost());
                // No single email open any more: its card goes. "scanning" leaves it
                // alone, since the new email replaces it as soon as it arrives.
                if (status === "waiting" || status === "empty" || status === "error") {
                  openEmailRef.current = null;
                  quote.clear();
                }
              }}
            />
            </div>
            <button type="button" onClick={startBlankQuote} className={secondaryButton}>
              Blank quote
            </button>
          </div>

          {canPaste && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handlePastedSubmit();
              }}
              className="flex flex-col gap-2"
            >
              <input
                value={pasted.from}
                onChange={(e) => setPasted((p) => ({ ...p, from: e.target.value }))}
                placeholder="Sender's email (optional, picks their Xcelerator account)"
                className={inputClass}
              />
              <textarea
                value={pasted.body}
                onChange={(e) => setPasted((p) => ({ ...p, body: e.target.value }))}
                placeholder="Paste the customer's quote email here"
                rows={6}
                className={`${inputClass} resize-y`}
              />
              <div>
                <button type="submit" disabled={!pasted.body.trim() || busy} className={primaryButton}>
                  Read quote
                </button>
              </div>
            </form>
          )}
        </section>

        {s.status === "idle" && (
          <div
            className={`flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-6 ${embedded ? "py-6" : "py-16"} text-center dark:border-zinc-700 dark:bg-zinc-900/40`}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
              <TagIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">No quote open</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                {canPaste
                  ? "Paste a quote email above, or start a blank quote."
                  : "Open a quote email in Missive and its details fill in here, or start a blank quote."}
              </p>
            </div>
          </div>
        )}

        {s.status === "checking" && (
          <div
            aria-busy="true"
            className={`animate-pulse rounded-2xl border border-zinc-200/70 bg-white ${card} dark:border-zinc-800/70 dark:bg-zinc-900`}
          >
            <div className="h-4 w-48 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Reading {s.email.subject ? `“${s.email.subject}”` : "the email"} and its thread for a quote request…
            </p>
            <div className="mt-6 space-y-4">
              <div className="h-3 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-3 w-5/6 rounded-full bg-zinc-100 dark:bg-zinc-800" />
            </div>
          </div>
        )}

        {(s.status === "not-quote" || s.status === "error") && (
          <div
            className={`flex flex-col gap-3 rounded-2xl border ${
              s.status === "error"
                ? "border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950"
                : "border-zinc-200/70 bg-white dark:border-zinc-800/70 dark:bg-zinc-900"
            } ${card}`}
          >
            <div>
              <p
                className={`text-sm font-medium ${
                  s.status === "error" ? "text-red-700 dark:text-red-300" : "text-zinc-900 dark:text-zinc-100"
                }`}
              >
                {s.status === "error"
                  ? `Couldn't check this email (${s.message.replace(/\.+$/, "")}).`
                  : "This email doesn't look like a quote request."}
              </p>
              {s.email.subject && (
                <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">{s.email.subject}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void quote.check(s.email, s.conversationId, { assumeQuote: true })}
                className={primaryButton}
              >
                Quote it anyway
              </button>
              {s.status === "error" && (
                <button
                  type="button"
                  onClick={() => void quote.check(s.email, s.conversationId)}
                  className={secondaryButton}
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        {s.status === "reading-documents" && (
          <QuoteReadingDocuments summary={s.detection.summary} documents={s.documents} cardClass={card} />
        )}

        {s.status === "ready" && (
          <QuoteRequest
            key={s.id}
            detection={s.detection}
            email={s.email}
            missiveHost={missiveHost}
            cardClass={card}
          />
        )}
      </main>
    </div>
  );
}
