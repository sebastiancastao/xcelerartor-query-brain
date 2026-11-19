import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { InquiryEmail } from "@/lib/agent";
import {
  EmailDocumentError,
  conversationThreadForQuote,
  quoteDocumentNames,
  readDocumentsForQuote,
} from "@/lib/email-documents";
import { isMissiveConfigured } from "@/lib/missive";
import { extractUuid } from "@/lib/missive-id";
import { fuelAssignmentFor } from "@/lib/fuel-defaults";
import { detectQuoteRequest, mightBeQuoteRequest } from "@/lib/quote-request";
import { readQuoteFieldsByRules } from "@/lib/quote-rules";
import type { QuoteFuelAssignment, QuoteRequestDetection, ThreadMessage } from "@/lib/quote-types";

// Says whether the email open in Missive asks for a price quote, and what
// shipment details it gives, in two steps so ordinary emails stay quick:
//
// 1. The email and its thread's earlier messages (from the page, which reads
//    them through Missive as the signed-in CSR, else through the app's Missive
//    token). The answer also names the thread's documents.
// 2. Only for a quote request with documents, the page asks again with
//    `withDocuments`: the same reading plus the attachments and document
//    links themselves (PDFs, images, Office files), which often carry the
//    weights, pieces and addresses the email leaves out.

// Downloading and reading several PDFs can take most of a minute.
export const maxDuration = 120;

const THREAD_MAX = 10;
const THREAD_TEXT_CHARS = 2500;

function readThread(value: unknown): ThreadMessage[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .slice(0, THREAD_MAX)
    .map((m): ThreadMessage | null => {
      if (!m || typeof m !== "object") return null;
      const r = m as Record<string, unknown>;
      const text = typeof r.text === "string" ? r.text.trim().slice(0, THREAD_TEXT_CHARS) : "";
      if (!text) return null;
      return {
        from: typeof r.from === "string" ? r.from.slice(0, 200) : "",
        sentAt: typeof r.sentAt === "string" && !Number.isNaN(Date.parse(r.sentAt)) ? r.sentAt : null,
        text,
      };
    })
    .filter((m): m is ThreadMessage => m !== null);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Earlier messages whose text the open email already quotes are left out, so nothing is read twice. */
function notQuotedIn(email: InquiryEmail, thread: ThreadMessage[]): ThreadMessage[] {
  const body = squash(email.body);
  return thread.filter((m) => !body.includes(squash(m.text).slice(0, 200)));
}

function unavailableReason(error: unknown): string {
  if (error instanceof EmailDocumentError) return error.message;
  console.error("Reading the thread for a quote failed:", error);
  return "The email's attachments couldn't be read (Missive didn't answer).";
}

// A reading with documents takes several seconds, so the answer is kept for
// a while: opening the same email again shows the card straight away.
type Cached = { detection: QuoteRequestDetection; expiresAt: number };
const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, Cached>();

function cacheKey(conversationId: string, email: InquiryEmail, thread: ThreadMessage[], documents: string[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([email.subject, email.body, thread.map((m) => m.text), documents]))
    .digest("hex");
  return `${conversationId}:${hash}`;
}

function remember(key: string, detection: QuoteRequestDetection): void {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  while (cache.size >= 100) cache.delete(cache.keys().next().value as string);
  cache.set(key, { detection, expiresAt: now + CACHE_TTL_MS });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const e = body?.email as Record<string, unknown> | undefined;
  if (!e || typeof e.body !== "string" || !e.body.trim()) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const email: InquiryEmail = {
    subject: typeof e.subject === "string" ? e.subject : "",
    from: typeof e.from === "string" ? e.from : "",
    fromName: typeof e.fromName === "string" ? e.fromName : undefined,
    body: e.body,
  };
  const conversationId = extractUuid(body?.conversationId);
  const withDocuments = body?.withDocuments === true;
  const missive = Boolean(conversationId) && isMissiveConfigured();

  // The thread: the page's (read as the CSR), else the app token's.
  let thread = readThread(body?.thread);
  let documentsUnavailable: string | null = missive || !conversationId ? null : "Missive isn't connected (set MISSIVE_API_TOKEN), so attachments can't be read.";
  if (!thread && missive) {
    try {
      thread = await conversationThreadForQuote(conversationId!);
    } catch (error) {
      documentsUnavailable = unavailableReason(error);
    }
  }
  thread = notQuotedIn(email, thread ?? []);

  // The fuel surcharge to assign is looked up beside the reading (it is kept
  // for an hour), so the card opens with it filled in. Only for emails that
  // could be quote requests: it reserves and releases an order number.
  const fuel: Promise<QuoteFuelAssignment | undefined> = mightBeQuoteRequest(email, thread)
    ? (() => {
        const places = readQuoteFieldsByRules(email.subject, email.body);
        return fuelAssignmentFor(email.from, [places.pickupAddress, places.deliveryAddress]);
      })()
    : Promise.resolve(undefined);
  const withFuel = async (detection: QuoteRequestDetection): Promise<QuoteRequestDetection> =>
    detection.isQuoteRequest ? { ...detection, fuel: await fuel } : detection;

  try {
    if (!withDocuments) {
      // The document names are listed beside the reading, from the listing the thread came from.
      const names = missive && !documentsUnavailable
        ? quoteDocumentNames(conversationId!).catch((error: unknown) => {
            documentsUnavailable = unavailableReason(error);
            return null;
          })
        : Promise.resolve(null);
      const [detection, documents] = await Promise.all([
        detectQuoteRequest(email, { thread, documents: [] }).then(withFuel),
        names,
      ]);
      return NextResponse.json({
        detection: {
          ...detection,
          read: { threadMessages: thread.length, documents: [], skipped: documents?.skipped ?? [], documentsUnavailable },
        } satisfies QuoteRequestDetection,
        documentsToRead: detection.isQuoteRequest ? (documents?.toRead ?? []) : [],
      });
    }

    if (!missive || documentsUnavailable) {
      return NextResponse.json({ error: documentsUnavailable ?? "No Missive email to read." }, { status: 400 });
    }
    let documents: Awaited<ReturnType<typeof readDocumentsForQuote>>;
    let key: string;
    try {
      // Keyed on the documents planned (the listing is cached), so a cached reading skips the downloads.
      key = cacheKey(conversationId!, email, thread, (await quoteDocumentNames(conversationId!)).toRead);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return NextResponse.json({ detection: cached.detection });
      documents = await readDocumentsForQuote(conversationId!);
    } catch (error) {
      return NextResponse.json({ error: unavailableReason(error) }, { status: 502 });
    }

    const detection = await withFuel(
      await detectQuoteRequest(email, { thread, documents: documents.read }, { rulesFallback: false }),
    );
    const result: QuoteRequestDetection = {
      ...detection,
      read: {
        threadMessages: thread.length,
        documents: documents.read.map((d) => d.name),
        skipped: documents.skipped,
        documentsUnavailable: null,
      },
    };
    if (detection.isQuoteRequest) remember(key, result);
    return NextResponse.json({ detection: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read the email";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
