"use client";

import { useEffect, useRef, useState } from "react";
import type { EmailDocument } from "@/lib/email-documents";

/** The order on screen, which documents can be attached to. */
export type AttachTarget = {
  /** What the CSR knows it by, e.g. 3800544M. */
  reference: string;
  /** Xcelerator's id, e.g. 111.040926. */
  orderTrackingId: string;
  /** The ClientPortal login that found it, which does the upload. */
  caller: string;
};

/** A file already attached to the order in Xcelerator. */
export type OrderDocument = { id: number; name: string };

export type AttachState =
  | { status: "confirm" }
  | { status: "uploading" }
  | { status: "done"; name: string }
  | { status: "error"; message: string };

/**
 * A file name without extension, download counters ("agentalert (75).PDF")
 * or save timestamps ("agentalert - 2026-04-09T065523.356.PDF"), to spot a
 * file that is probably already on the order.
 */
function baseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/\s+-\s+\d{4}-\d{2}-\d{2}t[\d.]+$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

export type OrderAttachments = {
  /** The order files go to; null when no order is on screen. */
  target: AttachTarget | null;
  /** Each email document's attach progress, by document id. */
  states: Record<string, AttachState>;
  /** True while "Upload documents" is sending several files. */
  busy: boolean;
  /** A file already on the order that looks like this document, if any. */
  similar: (doc: EmailDocument) => OrderDocument | undefined;
  /** Shows the per-document confirm step in the documents panel. */
  ask: (docId: string) => void;
  /** Clears a document's confirm step or outcome. */
  cancel: (docId: string) => void;
  /** Attaches one document; resolves true when Xcelerator took it. */
  attach: (doc: EmailDocument) => Promise<boolean>;
  /** Attaches several documents one after another, skipping any already sent. */
  attachAll: (docs: EmailDocument[]) => Promise<void>;
};

/**
 * Attaching the open email's documents to the order on screen, shared by the
 * order card's "Upload documents" button and the documents panel's per-file
 * buttons so both show the same progress and a file is never sent twice.
 * Each upload is sent once and never retried automatically: after an unclear
 * failure the CSR checks the order in Xcelerator before trying again.
 */
export function useOrderAttachments(
  conversationId: string | null,
  scanId: number,
  target: AttachTarget | null,
): OrderAttachments {
  const [states, setStates] = useState<Record<string, AttachState>>({});
  const [orderDocs, setOrderDocs] = useState<OrderDocument[]>([]);
  const [busy, setBusy] = useState(false);
  // Read synchronously so a file queued by "Upload documents" and clicked in
  // the panel at the same time is only sent once.
  const statesRef = useRef<Record<string, AttachState>>({});
  const busyRef = useRef(false);

  // Results only count for the email and order they were started for.
  const key = conversationId && target ? `${conversationId}|${target.orderTrackingId}|${target.caller}` : "";
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  });

  function setDocState(docId: string, state: AttachState | null) {
    const next = { ...statesRef.current };
    if (state) next[docId] = state;
    else delete next[docId];
    statesRef.current = next;
    setStates(next);
  }

  useEffect(() => {
    // A different order (or email) starts with nothing attached or pending.
    statesRef.current = {};
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStates({});
    setOrderDocs([]);
    if (!key || !target) return;
    const params = new URLSearchParams({ orderTrackingId: target.orderTrackingId, caller: target.caller });
    fetch(`/api/web-agent/order-documents?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.documents && keyRef.current === key) setOrderDocs(data.documents as OrderDocument[]);
      })
      .catch(() => {});
    // key covers conversationId and target's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scanId]);

  async function attach(doc: EmailDocument): Promise<boolean> {
    if (!target || !conversationId || !doc.attachable) return false;
    const current = statesRef.current[doc.id]?.status;
    if (current === "uploading" || current === "done") return current === "done";
    const started = key;
    setDocState(doc.id, { status: "uploading" });
    try {
      const res = await fetch(
        `/api/missive/conversation/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(doc.id)}/attach`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderTrackingId: target.orderTrackingId, caller: target.caller }),
        },
      );
      const data = await res.json().catch(() => null);
      if (keyRef.current !== started) return false;
      if (!res.ok) {
        setDocState(doc.id, { status: "error", message: data?.error ?? `Attaching failed (HTTP ${res.status}).` });
        return false;
      }
      if (Array.isArray(data?.documents)) setOrderDocs(data.documents as OrderDocument[]);
      setDocState(doc.id, { status: "done", name: data?.added?.name ?? doc.name });
      return true;
    } catch {
      if (keyRef.current === started) {
        setDocState(doc.id, {
          status: "error",
          message: "Network error. Check the order's documents in Xcelerator before trying again.",
        });
      }
      return false;
    }
  }

  async function attachAll(docs: EmailDocument[]) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const started = key;
    try {
      // One at a time: the portal session is shared, and a failure on one
      // file shouldn't hide whether the next one went through.
      for (const doc of docs) {
        if (keyRef.current !== started) break;
        await attach(doc);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    target: key ? target : null,
    states,
    busy,
    similar: (doc) => (doc.attachable ? orderDocs.find((d) => baseName(d.name) === baseName(doc.name)) : undefined),
    ask: (docId) => setDocState(docId, { status: "confirm" }),
    cancel: (docId) => setDocState(docId, null),
    attach,
    attachAll,
  };
}
