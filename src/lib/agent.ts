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
  pod: { available: boolean; signedBy: string | null };
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
    pod: { available: order.pod.available, signedBy: order.pod.receivedBy },
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

/**
 * Drafts the reply from an order the caller already has in hand (the web
 * agent page, which reads the order off the portal UI), so no lookup API is
 * called. Same compact projection and prompt budget as draftReplyForOrder.
 */
export async function draftReplyFromOrder(order: OrderInquiry): Promise<string> {
  if (!isOpenAIConfigured()) return buildSuggestedReply(order);

  const res = await chatCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT.replace(/Call get_order_by_reference_number to get the facts before writing anything/, "Use only the order facts provided") },
      {
        role: "user",
        content: `Draft a reply for order ${order.referenceNumber}. Order facts: ${JSON.stringify(toToolResult(order))}`,
      },
    ],
    maxTokens: 220,
  });
  return res.choices[0]?.message.content || buildSuggestedReply(order);
}
