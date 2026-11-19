"use client";

import { useEffect, useRef, useState } from "react";
import type { QuoteInputs } from "@/lib/quote-types";
import type { PlannedAddress, SavedXceleratorQuote, XceleratorAccount, XceleratorQuotePlan } from "@/lib/xcelerator-quote";

type SaveState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "preview"; plan: XceleratorQuotePlan }
  | { status: "saving"; plan: XceleratorQuotePlan }
  | { status: "saved"; saved: SavedXceleratorQuote }
  | { status: "error"; message: string };

function accountLabel(a: XceleratorAccount): string {
  return `[${a.accountNo}] ${a.companyName}`;
}

function addressLine(a: PlannedAddress): string {
  return [a.coName, a.street, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ");
}

const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The quote card's "Save in Xcelerator" section, shown once a quote is
 * priced. Finds the sender's account (or lets the CSR search for one), shows
 * exactly what Xcelerator would store, and saves it as a quote only when the
 * CSR confirms. Xcelerator keeps quotes under an account only, so a new
 * customer needs an account picked (for example a prospects account).
 */
export function XceleratorQuoteSave({
  inputs,
  pickupAddress,
  deliveryAddress,
  pieces,
  pallets,
  senderEmail,
  callerName,
}: {
  /** The inputs the quote was priced with (the server prices them again). */
  inputs: QuoteInputs;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  pieces: number | null;
  pallets: number | null;
  senderEmail: string;
  callerName: string;
}) {
  const [account, setAccount] = useState<XceleratorAccount | null>(null);
  const [candidates, setCandidates] = useState<XceleratorAccount[]>([]);
  const [suggesting, setSuggesting] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<XceleratorAccount[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const placesSet = Boolean(pickupAddress && deliveryAddress);

  // The sender's account, looked up once for this priced quote.
  const suggestedRef = useRef(false);
  useEffect(() => {
    if (suggestedRef.current) return;
    suggestedRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/web-agent/quote/xcelerator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "suggest", senderEmail, pickupAddress, deliveryAddress }),
        });
        const data = (await res.json().catch(() => null)) as
          | { account?: XceleratorAccount | null; candidates?: XceleratorAccount[]; error?: string }
          | null;
        if (!res.ok) {
          setSave({ status: "error", message: data?.error ?? `Xcelerator error (${res.status})` });
        } else {
          setAccount(data?.account ?? null);
          setCandidates(data?.candidates ?? []);
        }
      } catch {
        // The CSR can still search for the account.
      } finally {
        setSuggesting(false);
      }
    })();
    // Runs once per priced quote (the section is re-created when the quote is recalculated).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Account search as the CSR types.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/web-agent/quote/xcelerator/accounts?q=${encodeURIComponent(q)}`);
        const data = (await res.json().catch(() => null)) as { accounts?: XceleratorAccount[]; error?: string } | null;
        if (cancelled) return;
        setResults(res.ok ? (data?.accounts ?? []) : []);
        setSearchError(res.ok ? "" : (data?.error ?? "The account search failed."));
      } catch {
        if (!cancelled) setSearchError("The account search failed.");
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function choose(a: XceleratorAccount) {
    setAccount(a);
    setQuery("");
    setResults(null);
    setSave({ status: "idle" });
  }

  async function send(action: "preview" | "save") {
    if (!account || !placesSet) return;
    const plan = save.status === "preview" ? save.plan : null;
    setSave(action === "preview" ? { status: "checking" } : { status: "saving", plan: plan! });
    try {
      const res = await fetch("/api/web-agent/quote/xcelerator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          accountNo: account.accountNo,
          inputs,
          pickupAddress,
          deliveryAddress,
          pieces,
          pallets,
          callerName,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { plan?: XceleratorQuotePlan; saved?: SavedXceleratorQuote; error?: string }
        | null;
      if (!res.ok) {
        setSave({ status: "error", message: data?.error ?? `Xcelerator error (${res.status})` });
      } else if (action === "preview" && data?.plan) {
        setSave({ status: "preview", plan: data.plan });
      } else if (action === "save" && data?.saved) {
        setSave({ status: "saved", saved: data.saved });
      } else {
        setSave({ status: "error", message: "Xcelerator gave no answer." });
      }
    } catch {
      setSave({ status: "error", message: "Network error. Try again." });
    }
  }

  if (save.status === "saved") {
    const s = save.saved;
    return (
      <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-300">
        <p className="font-medium">
          Saved in Xcelerator as quote {s.quoteRef} under {accountLabel(s.account)}, {s.total}.
        </p>
        <p className="mt-1 text-xs">
          To book it, open Order Entry, load account {s.account.accountNo} and enter {s.quoteRef} in Quick Ref.
        </p>
      </div>
    );
  }

  const plan = save.status === "preview" || save.status === "saving" ? save.plan : null;
  const busy = save.status === "checking" || save.status === "saving";

  return (
    <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Save in Xcelerator</h3>

      <div className="mt-2 flex flex-col gap-2 text-sm">
        {account ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-600 dark:text-zinc-400">Account:</span>
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
              {accountLabel(account)}
            </span>
            <button
              type="button"
              onClick={() => {
                setAccount(null);
                setSave({ status: "idle" });
              }}
              disabled={busy}
              className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={suggesting ? "Looking up the sender's account…" : "Search an account by name or number"}
              className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            {searchError && <span className="text-xs text-red-600 dark:text-red-400">{searchError}</span>}
            {(query.trim().length >= 2 && results ? results : candidates).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(query.trim().length >= 2 && results ? results : candidates).map((a) => (
                  <button
                    key={a.clientId}
                    type="button"
                    onClick={() => choose(a)}
                    className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs text-zinc-700 hover:border-indigo-400 hover:text-indigo-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-indigo-300"
                  >
                    {accountLabel(a)}
                  </button>
                ))}
              </div>
            )}
            {query.trim().length >= 2 && results?.length === 0 && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">No account starts with that.</span>
            )}
            {!suggesting && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {candidates.length > 0 ? "Pick the sender's account. " : "No account matched the sender. "}
                Xcelerator keeps quotes under an account only, so for a new customer pick a prospects account or add the
                customer under Accounting, Clients first.
              </span>
            )}
          </>
        )}
      </div>

      {plan && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <dt className="text-zinc-500 dark:text-zinc-400">Account</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">{accountLabel(plan.account)}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Pickup</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">{addressLine(plan.pickup)}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Delivery</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">{addressLine(plan.delivery)}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Vehicle</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">
            {plan.vehicle} · {plan.service}
            {plan.packages && ` · ${plan.packages}`}
          </dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Price</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-100">{plan.total} (rate sheet, entered as a manual price)</dd>
          {plan.notes.map((note) => (
            <dd key={note} className="col-span-2 text-amber-700 dark:text-amber-400">
              {note}
            </dd>
          ))}
          {(plan.pickup.street === "" || plan.delivery.street === "") && (
            <dd className="col-span-2 text-amber-700 dark:text-amber-400">
              Google found only the city for a place with no street, so check it in Xcelerator when booking.
            </dd>
          )}
        </dl>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {plan ? (
          <>
            <button
              type="button"
              onClick={() => void send("save")}
              disabled={busy}
              className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400`}
            >
              {save.status === "saving" ? "Saving…" : "Save quote in Xcelerator"}
            </button>
            <button
              type="button"
              onClick={() => setSave({ status: "idle" })}
              disabled={busy}
              className={`${buttonClass} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void send("preview")}
            disabled={!account || !placesSet || busy}
            title={!placesSet ? "Fill in the pickup and delivery places first" : !account ? "Choose the account first" : undefined}
            className={`${buttonClass} border border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950`}
          >
            {save.status === "checking" ? "Checking with Xcelerator…" : "Check quote for Xcelerator"}
          </button>
        )}
        {!plan && <span className="text-xs text-zinc-500 dark:text-zinc-400">Nothing is saved until you confirm.</span>}
      </div>

      {save.status === "error" && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{save.message}</p>}
    </div>
  );
}
