"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentSummary, EmailDocument } from "@/lib/email-documents";
import { openLinkInNewTab } from "./MissiveEmailSense";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; documents: EmailDocument[]; summariesEnabled: boolean };

type SummaryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: DocumentSummary };

/** Documents summarized as soon as the email opens; the rest have a Summarize button. */
const AUTO_SUMMARY_LIMIT = 6;
/** Summaries requested at once. */
const SUMMARY_CONCURRENCY = 2;

function formatSize(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const BADGE_TONES: Record<string, string> = {
  PDF: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900",
  Image: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900",
  Excel: "bg-green-50 text-green-700 ring-green-200 dark:bg-green-950/50 dark:text-green-300 dark:ring-green-900",
  CSV: "bg-green-50 text-green-700 ring-green-200 dark:bg-green-950/50 dark:text-green-300 dark:ring-green-900",
  Word: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-900",
};
const DEFAULT_BADGE = "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700";
const LINK_BADGE = "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:ring-indigo-900";

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const buttonClass =
  "inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

function Preview({ doc }: { doc: EmailDocument }) {
  if (!doc.fileUrl || !doc.preview) return null;
  const frame = "mt-2 w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-800";
  if (doc.preview === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={doc.fileUrl} alt={doc.name} className={`${frame} max-h-[480px] object-contain`} />;
  }
  if (doc.preview === "text") {
    return <iframe src={doc.fileUrl} sandbox="" title={doc.name} className={`${frame} h-64`} />;
  }
  return (
    <object data={doc.fileUrl} type="application/pdf" className={`${frame} h-[480px]`} aria-label={doc.name}>
      <p className="p-3 text-sm text-zinc-600 dark:text-zinc-400">
        This viewer can&apos;t show PDFs inline.{" "}
        <a
          href={doc.fileUrl}
          onClick={openLinkInNewTab}
          className="text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
        >
          Open it instead
        </a>
        .
      </p>
    </object>
  );
}

/** Details shown before "Show N more", so several documents fit in the narrow Missive panel. */
const FACTS_SHOWN = 4;

function SummaryBlock({
  state,
  onLookup,
}: {
  state: SummaryState | undefined;
  onLookup: (reference: string) => void;
}) {
  const [allFacts, setAllFacts] = useState(false);
  if (!state) return null;
  if (state.status === "loading") {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500" />
        Reading the document…
      </p>
    );
  }
  if (state.status === "error") {
    return <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{state.message}</p>;
  }
  const { summary } = state;
  const facts = allFacts ? summary.keyFacts : summary.keyFacts.slice(0, FACTS_SHOWN);
  const hidden = summary.keyFacts.length - FACTS_SHOWN;
  return (
    <div className="mt-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{summary.docType}</p>
      <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">{summary.summary}</p>
      {summary.keyFacts.length > 0 && (
        <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {facts.map((fact, i) => (
            <div key={i} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-400">{fact.label}</dt>
              <dd className="break-words text-zinc-800 dark:text-zinc-200">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAllFacts((open) => !open)}
          aria-expanded={allFacts}
          className="mt-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {allFacts ? "Show fewer details" : `Show ${hidden} more ${hidden === 1 ? "detail" : "details"}`}
        </button>
      )}
      {summary.references.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Look up:</span>
          {summary.references.map((ref) => (
            <button
              key={ref}
              type="button"
              onClick={() => onLookup(ref)}
              title={`Look up ${ref}`}
              className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-indigo-500 dark:hover:text-indigo-400"
            >
              {ref}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Attachments and document links in the email open in Missive, each with an
 * AI summary, an inline preview and an Open button. Renders nothing until
 * an email is open, and nothing when the email has no documents.
 */
export function EmailDocuments({
  conversationId,
  scanId,
  onLookup,
  onCount,
  cardClass,
}: {
  conversationId: string | null;
  /** Changes on every scan of the email (including Rescan), which reloads the list. */
  scanId: number;
  /** Looks up an order number found in a document. */
  onLookup: (reference: string) => void;
  /** Told how many documents the email has once known, and null while unknown. */
  onCount?: (count: number | null) => void;
  cardClass: string;
}) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  // Only the newest email's requests may update the panel.
  const seqRef = useRef(0);
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  });

  async function summarize(id: string, seq: number) {
    if (!conversationId) return;
    setSummaries((s) => ({ ...s, [id]: { status: "loading" } }));
    try {
      const res = await fetch(
        `/api/missive/conversation/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(id)}/summary`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => null);
      if (seq !== seqRef.current) return;
      setSummaries((s) => ({
        ...s,
        [id]: res.ok && data?.summary
          ? { status: "ready", summary: data.summary as DocumentSummary }
          : { status: "error", message: data?.error ?? `Couldn't summarize it (HTTP ${res.status}).` },
      }));
    } catch {
      if (seq === seqRef.current) setSummaries((s) => ({ ...s, [id]: { status: "error", message: "Network error. Try again." } }));
    }
  }

  useEffect(() => {
    onCountRef.current?.(null);
    if (!conversationId) return;
    const seq = ++seqRef.current;
    // Resetting here is the point of this effect: a new email clears the old one's documents.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setList({ status: "loading" });
    setSummaries({});
    setPreviews({});

    (async () => {
      try {
        const res = await fetch(`/api/missive/conversation/${encodeURIComponent(conversationId)}/documents`);
        const data = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          setList({ status: "error", message: data?.error ?? `Couldn't read this email's documents (HTTP ${res.status}).` });
          return;
        }
        const documents = (data?.documents ?? []) as EmailDocument[];
        const summariesEnabled = Boolean(data?.summaries);
        setList({ status: "ready", documents, summariesEnabled });
        onCountRef.current?.(documents.length);
        if (!summariesEnabled) return;

        const queue = documents.filter((d) => d.summarizable).slice(0, AUTO_SUMMARY_LIMIT).map((d) => d.id);
        const worker = async () => {
          for (let id = queue.shift(); id && seq === seqRef.current; id = queue.shift()) await summarize(id, seq);
        };
        await Promise.all(Array.from({ length: SUMMARY_CONCURRENCY }, worker));
      } catch {
        if (seq === seqRef.current) setList({ status: "error", message: "Network error while reading this email's documents." });
      }
    })();
    // summarize only reads conversationId, which is a dependency already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, scanId]);

  if (!conversationId) return null;
  if (list.status === "ready" && list.documents.length === 0) return null;

  return (
    <section
      id="email-documents"
      className={`scroll-mt-3 rounded-2xl border border-zinc-200/70 bg-white ${cardClass} shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900`}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        <DocumentIcon className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
        Documents in this email
        {list.status === "ready" && (
          <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">{list.documents.length}</span>
        )}
      </h2>

      {list.status === "loading" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500" />
          Checking the email for attachments and links…
        </p>
      )}
      {list.status === "error" && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{list.message}</p>}

      {list.status === "ready" && (
        <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.documents.map((doc) => {
            const summary = summaries[doc.id];
            const meta = [
              doc.kind === "attachment" ? "Attached" : doc.host,
              formatSize(doc.size),
              doc.from ? `from ${doc.from}` : null,
            ].filter(Boolean);
            const canSummarize = list.summariesEnabled && doc.summarizable;
            return (
              <li key={doc.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                      doc.kind === "link" && doc.typeLabel === "Link" ? LINK_BADGE : (BADGE_TONES[doc.typeLabel] ?? DEFAULT_BADGE)
                    }`}
                  >
                    {doc.kind === "link" && doc.typeLabel !== "Link" ? `${doc.typeLabel} link` : doc.typeLabel}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={doc.name}>
                      {doc.name}
                    </p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={meta.join(" · ")}>
                      {meta.join(" · ")}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {doc.preview && doc.fileUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviews((p) => ({ ...p, [doc.id]: !p[doc.id] }))}
                      aria-expanded={Boolean(previews[doc.id])}
                      className={buttonClass}
                    >
                      {previews[doc.id] ? "Hide preview" : "Preview"}
                    </button>
                  )}
                  <a href={doc.openUrl} onClick={openLinkInNewTab} rel="noopener noreferrer" className={buttonClass}>
                    Open
                  </a>
                  {canSummarize && (!summary || summary.status === "error") && (
                    <button
                      type="button"
                      onClick={() => void summarize(doc.id, seqRef.current)}
                      className={buttonClass}
                    >
                      {summary ? "Try again" : "Summarize"}
                    </button>
                  )}
                </div>

                {previews[doc.id] && <Preview doc={doc} />}
                {doc.note && !summary && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{doc.note}</p>}
                <SummaryBlock state={summary} onLookup={onLookup} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
