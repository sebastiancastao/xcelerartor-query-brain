"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
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
  /** Asks Missive to open a link in the user's browser. */
  openURL: (url: string) => void;
  /** Opens a reply draft to the latest message of the open conversation; sends it only when deliver is true. */
  reply: (options: { deliver?: boolean }) => Promise<unknown>;
  /** Inserts HTML in the currently selected composer. */
  insertHtml: (html: string) => Promise<unknown> | undefined;
  /** Set once Missive has initialized this page; null when it is open outside Missive. */
  id?: string | null;
};

declare global {
  interface Window {
    Missive?: MissiveIframeApi;
  }
}

/**
 * onClick for links that open in a new tab. Use it instead of
 * target="_blank": missive.js (loaded on every page that has this component)
 * catches clicks on target="_blank" links and asks Missive to open them, so
 * outside Missive, where nothing answers, those clicks did nothing. Without
 * the target attribute missive.js leaves the link alone, and this opens it
 * through Missive when Missive is hosting the page, else in a new tab.
 */
export function openLinkInNewTab(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const url = event.currentTarget.href;
  const missive = window.Missive;
  if (missive?.id && typeof missive.openURL === "function") {
    missive.openURL(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** True when Missive is hosting this page, so its composer can be reached. */
export function isMissiveHost(): boolean {
  const missive = window.Missive;
  return Boolean(missive?.id && typeof missive.reply === "function" && typeof missive.insertHtml === "function");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text as the paragraph HTML Missive uses for message bodies: blank lines split paragraphs, single newlines become line breaks. */
function textToEmailHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => `<p>${paragraph.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a Missive call, but no longer than `ms`: Missive may never answer some calls. */
async function settleWithin(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens a reply to the latest message of the email open in Missive and puts
 * `text` in it. Nothing is sent: the reply is opened with deliver false, so
 * the CSR reads it, edits it if needed, and sends it from Missive. The text
 * goes in through insertHtml, which Missive documents as HTML, so the
 * paragraphs survive; Missive does not document the format of a reply body.
 */
export async function insertIntoMissiveReply(text: string): Promise<void> {
  const missive = window.Missive;
  if (!missive || !isMissiveHost()) throw new Error("This page is not open inside Missive.");

  await settleWithin(missive.reply({ deliver: false }), 4000);
  const html = textToEmailHtml(text);

  // Give the new reply's composer a moment to become the selected one, and
  // retry if Missive says there is no composer yet.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await wait(attempt === 0 ? 300 : 600);
    try {
      await settleWithin(missive.insertHtml(html), 4000);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(typeof lastError === "string" && lastError ? lastError : "Missive did not accept the text.");
}

type ConversationTextResponse = {
  email: { subject: string; body: string; from: string; receivedAt: string } | null;
  error?: string;
};

function statusLabel(
  status: MissiveSenseStatus,
  subject: string,
  errorMessage: string,
  pasteFallback: boolean,
): string {
  switch (status) {
    case "loading-script":
      return "Connecting to Missive…";
    case "not-embedded":
      return pasteFallback
        ? "Not opened inside Missive — paste an email below to detect its order #."
        : "Not opened inside Missive — type an order # above.";
    case "waiting":
      return "Open an email in Missive — its order # will appear in the search box above.";
    case "scanning":
      return "Scanning the selected email…";
    case "ready":
      return subject ? `Scanned: "${subject}"` : "Scanned the selected email.";
    case "empty":
      return "No order or reference number detected in the selected email.";
    case "not-configured":
      return pasteFallback
        ? "Missive isn't connected yet (set MISSIVE_API_TOKEN) — paste an email below instead."
        : "Missive isn't connected yet (set MISSIVE_API_TOKEN) — type an order # above.";
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
  pasteFallback = true,
}: {
  onEmailText: (text: string, meta: { subject: string; from: string; conversationId: string }) => void;
  onStatusChange?: (status: MissiveSenseStatus) => void;
  /** Whether the page has a "paste an email" box for the status line to point to. */
  pasteFallback?: boolean;
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
        <span>{statusLabel(status, subject, errorMessage, pasteFallback)}</span>
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
