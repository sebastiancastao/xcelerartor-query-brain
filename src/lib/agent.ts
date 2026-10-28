// Agent that drafts CSR replies. It's handed exactly one tool —
// get_order_by_reference_number, mirroring GET /api/orders/{referenceNumber}
// — and decides for itself whether to call it. System instructions require
// every claim to be grounded in that tool's output, so in practice it always
// calls it, but the decision is the model's, not hardcoded.
//
// Token-usage choices, in one place since they're easy to erode later:
//  - The tool returns a compact projection, never the raw OrderInquiry. The
//    POD field alone can be a multi-KB base64 JPEG (thousands of tokens) —
//    it never reaches the model, only an `available`/`signedBy` summary.
//  - System prompt is short and byte-identical across calls, so it's a
//    stable prefix OpenAI can cache.
//  - max_tokens is capped on both turns (the tool-call turn barely needs
//    any completion tokens; the reply turn only needs a short email).
//  - No conversation history accumulates — each draft is a fresh 2-message
//    exchange, not a growing chat log.

import { getOrderByReferenceNumber, type OrderInquiry } from "./xcelerator";
import { buildSuggestedReply } from "./email";
import { chatCompletion, isOpenAIConfigured, type ChatMessage, type ToolDefinition } from "./openai";

type OrderToolResult = {
  referenceNumber: string;
  customer: string;
  status: string;
  pickup: { arrived: boolean; when: string | null; scheduled: string };
  delivery: { delivered: boolean; when: string | null; scheduled: string };
  pod: { available: boolean; signedBy: string | null; signedAt: string | null };
  charges: {
    finalized: boolean;
    total: number | null;
    currency: string;
    lineItems: { label: string; amount: number }[];
  };
};

function toToolResult(order: OrderInquiry): OrderToolResult {
  return {
    referenceNumber: order.referenceNumber,
    customer: order.customer,
    status: order.status,
    pickup: {
      arrived: order.pickup.arrived,
      when: order.pickup.arrivedAt,
      scheduled: order.pickup.scheduledAt,
    },
    delivery: {
      delivered: order.delivery.delivered,
      when: order.delivery.deliveredAt,
      scheduled: order.delivery.scheduledAt,
    },
    // The POD activity log stays out: it names staff logins and internal emails.
    pod: { available: order.pod.available, signedBy: order.pod.receivedBy, signedAt: order.pod.signedAt ?? null },
    charges: {
      finalized: order.charges.finalized,
      total: order.charges.finalized ? order.charges.total : null,
      currency: order.charges.currency,
      lineItems: order.charges.lineItems,
    },
  };
}

const GET_ORDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_order_by_reference_number",
    description:
      "GET pickup, delivery, POD, and charges status for a shipment from Xcelerator, " +
      "keyed by client reference, Xcelerator order tracking id, or package reference. " +
      "Mirrors GET /api/orders/{referenceNumber}.",
    parameters: {
      type: "object",
      properties: {
        referenceNumber: { type: "string", description: "e.g. REF-1003 or 105.081826" },
      },
      required: ["referenceNumber"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT =
  "You are a CSR assistant for a freight courier. Draft a short, friendly email reply " +
  "to a customer's order inquiry, covering: has the driver arrived at pickup, has the " +
  "order been delivered, POD status, and final charges. Call get_order_by_reference_number " +
  "to get the facts before writing anything — never state a status you didn't get from the " +
  "tool. If a value isn't available yet, say so plainly rather than guessing. Under 120 " +
  "words, no subject line.";

export async function draftReplyForOrder(referenceNumber: string): Promise<string> {
  if (!isOpenAIConfigured()) {
    const order = await getOrderByReferenceNumber(referenceNumber);
    if (!order) throw new Error("Order not found");
    return buildSuggestedReply(order);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Draft a reply for order ${referenceNumber}.` },
  ];

  const first = await chatCompletion({
    messages,
    tools: [GET_ORDER_TOOL],
    toolChoice: "auto",
    maxTokens: 60,
  });

  const assistantMessage = first.choices[0]?.message;
  const toolCall = assistantMessage?.tool_calls?.[0];

  if (!toolCall) {
    // Model chose not to call the tool — shouldn't happen given the system
    // prompt, but fall back to the deterministic template rather than
    // trusting an ungrounded reply.
    const order = await getOrderByReferenceNumber(referenceNumber);
    if (!order) throw new Error("Order not found");
    return buildSuggestedReply(order);
  }

  const { referenceNumber: requestedRef } = JSON.parse(toolCall.function.arguments) as {
    referenceNumber: string;
  };
  const order = await getOrderByReferenceNumber(requestedRef || referenceNumber);
  if (!order) throw new Error(`Order ${requestedRef || referenceNumber} not found`);
  const toolResult = toToolResult(order);

  const second = await chatCompletion({
    messages: [
      ...messages,
      { role: "assistant", content: assistantMessage.content, tool_calls: assistantMessage.tool_calls },
      { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) },
    ],
    maxTokens: 220,
  });

  const reply = second.choices[0]?.message.content;
  if (!reply) throw new Error("Model returned no reply.");
  return reply;
}

/** The customer email a reply answers: the latest message in the conversation open in Missive. */
export type InquiryEmail = {
  subject: string;
  /** Sender address, e.g. "ops@acme.com". */
  from: string;
  /** Sender display name, when the mail client sent one. */
  fromName?: string;
  body: string;
};

/** A drafted reply, plus what the model read the email as asking for when there was one. */
export type DraftedReply = { reply: string; asks: string[] };

// Long threads quote every earlier message; the newest text comes first, so
// cutting the tail keeps the actual request and bounds the prompt size.
const EMAIL_BODY_LIMIT = 6000;

const WHEN_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * Order times as a person reads them. Zone-less strings are the portal's own
 * wall clock and are printed as-is; zoned ones are shown in Eastern time,
 * the portal's zone.
 */
function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number);
    return new Date(Date.UTC(y, mo - 1, d, h, mi)).toLocaleString("en-US", { ...WHEN_FORMAT, timeZone: "UTC" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toLocaleString("en-US", { ...WHEN_FORMAT, timeZone: "America/New_York" })} ET`;
}

function windowText(from: string | null | undefined, to: string | null | undefined): string | null {
  const start = formatWhen(from);
  const end = formatWhen(to);
  if (start && end && end !== start) return `${start} to ${end}`;
  return start ?? end;
}

/** Drops null, empty-string, empty-array and empty-object fields so the model only sees facts that exist. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined && v !== null);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const c = compact(v);
      if (c === null || c === undefined || c === "") continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[key] = c;
    }
    return out;
  }
  return value;
}

/**
 * The order facts an email reply may draw on. Wider than toToolResult, since
 * a customer can ask about anything on the order (addresses, pieces, invoice
 * number, carrier tracking), but still a trimmed projection: the POD image,
 * the POD activity log (staff logins, internal emails), contact phone numbers
 * and special instructions never reach the model.
 */
function toReplyFacts(order: OrderInquiry): unknown {
  const place = (p: OrderInquiry["pickup"] | OrderInquiry["delivery"]) => ({
    company: p.company,
    address: [p.street, p.street2, p.location, p.zip].filter(Boolean).join(", ") || null,
  });
  return compact({
    referenceNumber: order.referenceNumber,
    otherReferences: [order.referenceNumber2, order.referenceNumber3, order.referenceNumber4],
    invoiceNumber: order.invoiceNumber,
    customer: order.customer,
    status: order.status,
    service: order.service,
    vehicle: order.vehicle,
    carrier: order.carrier,
    thirdPartyCarrierTrackingNumber: order.thirdPartyTrackingRefNo,
    pickup: {
      ...place(order.pickup),
      scheduledWindow: windowText(order.pickup.scheduledAt, order.pickup.scheduledTo),
      driverArrived: order.pickup.arrived,
      arrivedAt: formatWhen(order.pickup.arrivedAt),
      departedAt: formatWhen(order.pickup.departedAt),
    },
    delivery: {
      ...place(order.delivery),
      scheduledWindow: windowText(order.delivery.scheduledAt, order.delivery.scheduledTo),
      delivered: order.delivery.delivered,
      deliveredAt: formatWhen(order.delivery.deliveredAt),
    },
    shipment: {
      pieces: order.shipment.pieces,
      weight: order.shipment.weight,
      declaredValue: order.shipment.declaredValue,
    },
    cod: order.cod.amount ? { amount: order.cod.amount, collectAt: order.cod.location } : null,
    pod: {
      onFile: order.pod.available,
      signedBy: order.pod.receivedBy,
      signedAt: formatWhen(order.pod.signedAt),
    },
    charges: {
      finalized: order.charges.finalized,
      total: order.charges.finalized ? order.charges.total : null,
      currency: order.charges.currency,
      lineItems: order.charges.lineItems,
    },
    documentsOnFile: order.documents.map((d) => d.name),
  });
}

const EMAIL_REPLY_PROMPT = [
  "You are a customer service rep for a freight courier, replying to a customer's email about one shipment.",
  "Step 1: work out exactly what the email asks for: every question, every request, and any deadline or concern the customer raises (for example 'our dock closes at 4pm'), in the order they appear, each as a short phrase.",
  "Step 2: write the reply so it answers each of those, in that order, directly, using only the order facts provided.",
  "Answer only what the email asks. Do not mention anything it did not ask about: no POD, signature, charges, invoice, pickup or delivery details unless the email asks for them.",
  "If it only asks for a status or update, say where the shipment is now in one or two sentences: delivered and when, or the current stage and the scheduled delivery time.",
  "When the customer raises a deadline or constraint, say plainly whether the order facts meet it, and when they don't or it's unclear, say you'll check with dispatch and confirm.",
  "Never state anything that is not in the order facts. If it asks for something the facts don't show, say plainly that you're checking and will follow up.",
  "If it asks for an action (schedule a pickup, redeliver, change an address, hold, rush, quote, fix an invoice), acknowledge it and say you'll confirm. Never say it is done.",
  "Only when the email asks for the POD or proof of delivery: if it is on file, say a copy is attached and who signed and when; if not, say it is not available yet and you'll send it once it is.",
  "If it asks about other shipments too, say you'll check on those separately.",
  "Use today's date, given with the email, to say today, tomorrow or yesterday correctly.",
  "Greet the sender by first name if the email or sender name shows it, otherwise 'Hi,'. Reply in the language the email is written in.",
  "Plain text, short paragraphs, no subject line, no markdown, under 150 words. Sound like a helpful person, not a form letter. End with a short closing line such as 'Thanks,' and no name, signature or placeholder.",
  'Respond with JSON only: {"asks": ["..."], "reply": "..."}.',
].join(" ");

/** Today in the portal's zone, so the reply can say "today" or "tomorrow" correctly. */
function todayText(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function emailForPrompt(email: InquiryEmail): string {
  const body = email.body.trim();
  const clipped = body.length > EMAIL_BODY_LIMIT ? `${body.slice(0, EMAIL_BODY_LIMIT)}\n[...rest of thread cut]` : body;
  const sender = email.fromName ? `${email.fromName} <${email.from}>` : email.from;
  return `From: ${sender || "unknown"}\nSubject: ${email.subject || "(none)"}\n\n${clipped}`;
}

function parseDraft(content: string | null | undefined): DraftedReply | null {
  if (!content) return null;
  try {
    const data = JSON.parse(content) as { asks?: unknown; reply?: unknown };
    const reply = typeof data.reply === "string" ? data.reply.trim() : "";
    if (!reply) return null;
    const asks = Array.isArray(data.asks)
      ? data.asks.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
      : [];
    return { reply, asks };
  } catch {
    // A reply cut off mid-JSON (max_tokens) is not worth showing; the caller
    // falls back to the general update.
    return null;
  }
}

/**
 * Drafts the reply from an order the caller already has in hand (the web
 * agent page, which reads the order off the portal UI), so no lookup API is
 * called.
 *
 * With the customer's email, the reply answers exactly what that email asks
 * for, and `asks` lists those requests so the CSR can check the reading.
 * Without it, it falls back to the general pickup / delivery / POD / charges
 * update, with the same compact projection and prompt budget as
 * draftReplyForOrder.
 */
export async function draftReplyFromOrder(order: OrderInquiry, email?: InquiryEmail | null): Promise<DraftedReply> {
  if (!isOpenAIConfigured()) return { reply: buildSuggestedReply(order), asks: [] };

  if (email && email.body.trim()) {
    const res = await chatCompletion({
      messages: [
        { role: "system", content: EMAIL_REPLY_PROMPT },
        {
          role: "user",
          content:
            `Today is ${todayText()}.\n\nCustomer email:\n"""\n${emailForPrompt(email)}\n"""\n\n` +
            `Order facts (order ${order.referenceNumber}): ${JSON.stringify(toReplyFacts(order))}`,
        },
      ],
      responseFormat: { type: "json_object" },
      maxTokens: 600,
    });
    const draft = parseDraft(res.choices[0]?.message.content);
    if (draft) return draft;
  }

  const res = await chatCompletion({
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT.replace(/Call get_order_by_reference_number to get the facts before writing anything/, "Use only the order facts provided") +
          " End with a short closing line and no name, signature or placeholder.",
      },
      {
        role: "user",
        content: `Draft a reply for order ${order.referenceNumber}. Order facts: ${JSON.stringify(toToolResult(order))}`,
      },
    ],
    maxTokens: 220,
  });
  return { reply: res.choices[0]?.message.content || buildSuggestedReply(order), asks: [] };
}
