"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { extractUuids } from "@/lib/missive-id";

export type MissiveSenseStatus =
  | "loading-script"
  | "not-embedded"
  | "waiting"
  | "scanning"
  | "ready"
  | "empty"
  | "not-configured"
  | "error";

type MissiveIframeConversation = {
  id: string;
  latest_message?: { id: string } | null;
  messages_count?: number;
};

type MissiveIframeApi = {
  on: (
    event: "change:conversations",
    callback: (payload: unknown) => void,
    options?: { retroactive?: boolean }
  ) => void;
  fetchConversations: (ids: string[]) => Promise<MissiveIframeConversation[]>;
};

declare global {
  interface Window {
    Missive?: MissiveIframeApi;
  }
}

type ConversationTextResponse = {
  email: { subject: string; body: string; from: string; receivedAt: string } | null;
  error?: string;
};

function statusLabel(status: MissiveSenseStatus, subject: string, errorMessage: string): string {
  switch (status) {
    case "loading-script":
      return "Connecting to Missive…";
    case "not-embedded":
      return "Not opened inside Missive — paste an email below to detect its order #.";
    case "waiting":
      return "Open an email in Missive — its order # will appear in the search box above.";
    case "scanning":
      return "Scanning the selected email…";
    case "ready":
      return subject ? `Scanned: "${subject}"` : "Scanned the selected email.";
    case "empty":
      return "No order or reference number detected in the selected email.";
    case "not-configured":
      return "Missive isn't connected yet (set MISSIVE_API_TOKEN) — paste an email below instead.";
    case "error":
      return errorMessage || "Couldn't read the selected Missive email.";
    default:
      return "";
  }
}

// Senses whichever email conversation the CSR currently has open in Missive
// (when this page is embedded there as an integration panel) and reports its
// subject + body text up to the parent. It never picks a reference number or
// submits a lookup itself — the parent runs detection and only ever pre-fills
// the search box, which stays a normal, freely editable input.
export function MissiveEmailSense({
  onEmailText,
  onStatusChange,
}: {
  onEmailText: (text: string, meta: { subject: string; from: string; conversationId: string }) => void;
  onStatusChange?: (status: MissiveSenseStatus) => void;
}) {
  const [status, setStatus] = useState<MissiveSenseStatus>("loading-script");
  const [subject, setSubject] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");

  const lastScannedIdRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const listenerRegisteredRef = useRef(false);

  useEffect(() => {
    onStatusChange?.(status);
    // onStatusChange is expected to be a stable callback from the parent;
    // re-running this effect only on status change avoids extra churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const scanConversation = useCallback(
    async (conversationId: string) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSelectedConversationId(conversationId);
      setStatus("scanning");
      setErrorMessage("");

      try {
        const response = await fetch(`/api/missive/conversation/${encodeURIComponent(conversationId)}`);
        const data = (await response.json().catch(() => ({}))) as Partial<ConversationTextResponse>;
        if (requestId !== requestIdRef.current) return;

        if (response.status === 501) {
          setStatus("not-configured");
          return;
        }
        if (!response.ok) {
          throw new Error(data.error ?? `status ${response.status}`);
        }
        if (!data.email) {
          setSubject("");
          setStatus("empty");
          return;
        }

        setSubject(data.email.subject ?? "");
        setStatus("ready");
        onEmailText(`${data.email.subject ?? ""}\n\n${data.email.body ?? ""}`, {
          subject: data.email.subject ?? "",
          from: data.email.from ?? "",
          conversationId,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Couldn't read the selected Missive email."
        );
      }
    },
    [onEmailText]
  );

  const handleConversationChange = useCallback(
    async (payload: unknown) => {
      const ids = extractUuids(payload);

      if (ids.length !== 1) {
        requestIdRef.current += 1;
        lastScannedIdRef.current = null;
        setSelectedConversationId("");
        setSubject("");
        setStatus("waiting");
        return;
      }

      const missive = window.Missive;
      let conversationId = ids[0];

      try {
        const [conversation] = (await missive?.fetchConversations(ids)) ?? [];
        conversationId = extractUuids(conversation?.id)[0] ?? conversationId;
      } catch {
        // The backend can still resolve the selected conversation id.
      }

      // Missive can re-fire "change:conversations" for the same still-open
      // email (e.g. a label change) — skip re-scanning it so we don't stomp
      // a value the CSR has since edited by hand in the search box.
      if (conversationId === lastScannedIdRef.current) return;
      lastScannedIdRef.current = conversationId;

      await scanConversation(conversationId);
    },
    [scanConversation]
  );

  const registerMissiveListener = useCallback(() => {
    if (listenerRegisteredRef.current) return;

    if (!window.Missive) {
      setStatus("not-embedded");
      return;
    }

    listenerRegisteredRef.current = true;
    setStatus("waiting");

    try {
      window.Missive.on(
        "change:conversations",
        (ids) => {
          void handleConversationChange(ids);
        },
        { retroactive: true }
      );
    } catch {
      setStatus("error");
      setErrorMessage("Missive did not expose the selected conversation to this page.");
    }
  }, [handleConversationChange]);

  return (
    <>
      <Script
        src="https://integrations.missiveapp.com/missive.js"
        strategy="afterInteractive"
        onReady={registerMissiveListener}
        onError={() => {
          setStatus("not-embedded");
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            status === "ready"
              ? "bg-emerald-500"
              : status === "scanning" || status === "loading-script"
                ? "animate-pulse bg-indigo-400"
                : status === "error"
                  ? "bg-red-400"
                  : "bg-zinc-300 dark:bg-zinc-600"
          }`}
        />
        <span>{statusLabel(status, subject, errorMessage)}</span>
        {selectedConversationId && status !== "scanning" && (
          <button
            type="button"
            onClick={() => void scanConversation(selectedConversationId)}
            className="font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-400"
          >
            Rescan
          </button>
        )}
      </div>
    </>
  );
}
