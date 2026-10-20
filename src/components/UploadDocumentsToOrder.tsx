"use client";

import { useState } from "react";
import type { EmailDocument } from "@/lib/email-documents";
import type { EmailDocumentList } from "./EmailDocuments";
import type { AttachState, OrderAttachments } from "./useOrderAttachments";

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 13V3.5M6 7.5l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 12.5v3a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500" />;
}

function formatSize(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const secondaryButton =
  "inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

/** What a row says about its upload, if anything has happened yet. */
function RowStatus({ state, reference }: { state: AttachState; reference: string }) {
  if (state.status === "uploading") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <Spinner />
        Uploading to {reference}…
      </span>
    );
  }
  if (state.status === "done") {
    return <span className="block text-xs text-emerald-700 dark:text-emerald-400">✓ Uploaded as “{state.name}”</span>;
  }
  if (state.status === "error") {
    return <span className="block text-xs text-amber-700 dark:text-amber-400">{state.message}</span>;
  }
  return null;
}

/**
 * The order card's "Upload documents" button: sends the open email's PDFs
 * and images to the order on screen in Xcelerator, through the ClientPortal
 * login that found it. The CSR ticks which files go (files that look like
 * ones already on the order start unticked) and confirms once; files are
 * sent one at a time. Renders nothing until both an order and an email are
 * on screen. Give it a `key` per email and order so the choices reset.
 */
export function UploadDocumentsToOrder({
  attachments,
  list,
  onShowDocuments,
}: {
  attachments: OrderAttachments;
  /** The open email's documents; null when no email is open. */
  list: EmailDocumentList | null;
  /** Scrolls to the documents panel, where each file can be previewed. */
  onShowDocuments: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Only the CSR's own ticks; untouched files follow the default below.
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  // The files sent by the last "Upload N files", for the summary line.
  const [lastRun, setLastRun] = useState<string[] | null>(null);

  const { target, states, busy } = attachments;
  if (!target || !list) return null;

  if (list.status === "loading") {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <Spinner />
        Checking the email for documents to upload…
      </p>
    );
  }
  if (list.status === "error") {
    return (
      <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
        Couldn&apos;t read this email&apos;s documents, so there&apos;s nothing to upload yet.
      </p>
    );
  }

  const uploadable = list.documents.filter((d) => d.attachable);
  if (uploadable.length === 0) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled className={secondaryButton}>
          <UploadIcon className="h-3.5 w-3.5" />
          Upload documents to order
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {list.documents.length === 0
            ? "This email has no attachments or document links."
            : "Xcelerator only takes PDFs and images, and this email has none."}
        </span>
      </div>
    );
  }

  const isDone = (doc: EmailDocument) => states[doc.id]?.status === "done";
  const isChecked = (doc: EmailDocument) => !isDone(doc) && (picked[doc.id] ?? !attachments.similar(doc));
  const chosen = uploadable.filter((d) => isChecked(d) && states[d.id]?.status !== "uploading");
  const doneCount = uploadable.filter(isDone).length;

  const finished = lastRun && !busy ? lastRun : null;
  const runDone = finished ? finished.filter((id) => states[id]?.status === "done").length : 0;
  const runFailed = finished ? finished.filter((id) => states[id]?.status === "error").length : 0;

  async function upload() {
    const docs = chosen;
    if (docs.length === 0) return;
    setLastRun(docs.map((d) => d.id));
    await attachments.attachAll(docs);
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-left text-xs font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
      >
        <UploadIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">Upload documents to order {target.reference}</span>
        <span className="shrink-0 rounded-full bg-white/20 px-1.5 text-[11px] font-semibold">
          {doneCount > 0 ? `${doneCount}/${uploadable.length} done` : uploadable.length}
        </span>
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Choose the email&apos;s files to upload to order {target.reference}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {uploadable.map((doc) => {
              const state = states[doc.id];
              const similar = attachments.similar(doc);
              const locked = busy || isDone(doc) || state?.status === "uploading";
              const size = formatSize(doc.size);
              return (
                <li key={doc.id} className="flex items-start gap-2">
                  <input
                    id={`upload-${doc.id}`}
                    type="checkbox"
                    checked={isDone(doc) || isChecked(doc)}
                    disabled={locked}
                    onChange={(e) => setPicked((p) => ({ ...p, [doc.id]: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600 disabled:opacity-60"
                  />
                  <label htmlFor={`upload-${doc.id}`} className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-800 dark:text-zinc-200" title={doc.name}>
                      {doc.name}
                      {size && <span className="text-xs text-zinc-500 dark:text-zinc-400"> · {size}</span>}
                    </span>
                    {state && state.status !== "confirm" ? (
                      <RowStatus state={state} reference={target.reference} />
                    ) : (
                      similar && (
                        <span className="block text-xs text-amber-700 dark:text-amber-400">
                          The order already has “{similar.name}”. Tick it to upload anyway.
                        </span>
                      )
                    )}
                  </label>
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            Anyone who can open the order in the Xcelerator portal, including the customer, will see these files.{" "}
            <button
              type="button"
              onClick={onShowDocuments}
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View them
            </button>
          </p>

          {finished && (runDone > 0 || runFailed > 0) && (
            <p
              className={`mt-2 text-sm ${
                runFailed ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"
              }`}
            >
              Uploaded {runDone} of {finished.length} {finished.length === 1 ? "file" : "files"} to order{" "}
              {target.reference}.
              {runFailed > 0 && " Check the order's documents in Xcelerator before trying the others again."}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {(chosen.length > 0 || busy) && (
              <button
                type="button"
                onClick={() => void upload()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-indigo-500 dark:hover:bg-indigo-400"
              >
                {busy ? (
                  <>
                    <Spinner />
                    Uploading…
                  </>
                ) : (
                  `Upload ${chosen.length} ${chosen.length === 1 ? "file" : "files"}`
                )}
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className={secondaryButton}>
              {doneCount > 0 && chosen.length === 0 ? "Done" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
