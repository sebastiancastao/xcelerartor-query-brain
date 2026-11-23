"use client";

import { useCallback, useRef, useState } from "react";
import type { InquiryEmail } from "@/lib/agent";
import { readMissiveThread } from "@/components/MissiveEmailSense";
import type { QuoteRequestDetection, ThreadMessage } from "@/lib/quote-types";

/**
 * Where the check of one email for a price-quote request stands. `id`
 * changes per check, so a new email gets a fresh quote card.
 */
export type QuoteDetectionState =
  | { status: "idle" }
  | { status: "checking"; id: number; email: InquiryEmail; conversationId: string | null }
  /** Read, and not taken for a quote request; "Quote it anyway" can still read it as one. */
  | { status: "not-quote"; id: number; email: InquiryEmail; conversationId: string | null }
  /** A quote request whose attachments are being read before the card opens. */
  | { status: "reading-documents"; id: number; email: InquiryEmail; detection: QuoteRequestDetection; documents: string[] }
  | { status: "ready"; id: number; email: InquiryEmail; detection: QuoteRequestDetection }
  | { status: "error"; id: number; email: InquiryEmail; conversationId: string | null; message: string };

type DetectAnswer = {
  ok: boolean;
  data: { detection?: QuoteRequestDetection; documentsToRead?: string[]; error?: string } | null;
};

/**
 * Asks whether an email is a quote request. The email is read with its
 * thread's earlier messages; when it is a quote request with attachments or
 * document links, those are read too before the card opens, since they often
 * hold the weights and addresses. Only the newest check may update the state.
 */
export function useQuoteDetection() {
  const [state, setState] = useState<QuoteDetectionState>({ status: "idle" });
  const seqRef = useRef(0);

  const clear = useCallback(() => {
    seqRef.current += 1;
    setState({ status: "idle" });
  }, []);

  /** Shows a card straight away, e.g. a blank one the CSR fills in by hand. */
  const show = useCallback((email: InquiryEmail, detection: QuoteRequestDetection) => {
    const id = ++seqRef.current;
    setState({ status: "ready", id, email, detection });
  }, []);

  const check = useCallback(
    async (email: InquiryEmail, conversationId: string | null, options: { assumeQuote?: boolean } = {}) => {
      const id = ++seqRef.current;
      const current = () => id === seqRef.current;
      if (!email.body.trim()) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "checking", id, email, conversationId });
      const assumeQuote = options.assumeQuote === true;
      const ask = async (thread: ThreadMessage[] | null, withDocuments: boolean): Promise<DetectAnswer> => {
        const res = await fetch("/api/web-agent/quote/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, conversationId, thread, withDocuments, assumeQuote }),
        });
        return { ok: res.ok, data: (await res.json().catch(() => null)) as DetectAnswer["data"] };
      };
      try {
        // Read through Missive as the signed-in CSR; null lets the server try its own token.
        const thread = conversationId ? await readMissiveThread(conversationId) : null;
        if (!current()) return;
        const first = await ask(thread, false);
        if (!current()) return;
        const detection = first.data?.detection;
        if (!first.ok || !detection) {
          setState({
            status: "error",
            id,
            email,
            conversationId,
            message: first.data?.error ?? "The email couldn't be checked for a quote request",
          });
          return;
        }
        if (!detection.isQuoteRequest) {
          setState({ status: "not-quote", id, email, conversationId });
          return;
        }
        const toRead = first.data?.documentsToRead ?? [];
        if (toRead.length === 0) {
          setState({ status: "ready", id, email, detection });
          return;
        }

        setState({ status: "reading-documents", id, email, detection, documents: toRead });
        let withDocs: DetectAnswer | null = null;
        try {
          withDocs = await ask(thread, true);
        } catch {
          // Kept as the first reading below, with a note.
        }
        if (!current()) return;
        const read = withDocs?.data?.detection;
        if (withDocs?.ok && read) {
          // A second reading that no longer sees a quote request keeps the first one.
          setState({ status: "ready", id, email, detection: read.isQuoteRequest ? read : detection });
          return;
        }
        const why = withDocs?.data?.error ?? "Network error";
        setState({
          status: "ready",
          id,
          email,
          detection: {
            ...detection,
            read: {
              threadMessages: detection.read?.threadMessages ?? 0,
              documents: [],
              skipped: detection.read?.skipped ?? [],
              documentsUnavailable: `The attachments couldn't be read, so the card has only what the emails say (${why.replace(/\.+$/, "")}).`,
            },
          },
        });
      } catch {
        if (current()) {
          setState({ status: "error", id, email, conversationId, message: "Network error — please try again." });
        }
      }
    },
    [],
  );

  return { state, check, clear, show };
}
