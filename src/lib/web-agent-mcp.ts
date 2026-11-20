import type { InquiryEmail } from "@/lib/agent";
import { draftReplyFromOrder } from "@/lib/agent";
import { fuelAssignmentFor } from "@/lib/fuel-defaults";
import { routeMiles } from "@/lib/google-maps";
import { listOrderDocuments } from "@/lib/order-documents";
import { calculateQuote, readQuoteInputs } from "@/lib/quote-engine";
import { detectQuoteRequest, draftQuoteReply } from "@/lib/quote-request";
import { QUOTE_EXTRAS, TRIPS, VEHICLE_CLASSES, type ThreadMessage } from "@/lib/quote-types";
import { findOrderWithWebAgent, listFieldsFor, WebAgentError } from "@/lib/web-agent";
import {
  loadMemory,
  memoryBackend,
  rankCallers,
  rankTrackBy,
  referenceContext,
  rememberedPlace,
} from "@/lib/web-agent-memory";
import { reviewOrderUrl } from "@/lib/xcelerator-backoffice";
import type { OrderInquiry } from "@/lib/xcelerator";
import { xceleratorCallersFromEnv } from "@/lib/xcelerator-portal";
import {
  isXceleratorQuoteConfigured,
  previewXceleratorQuote,
  saveXceleratorQuote,
  searchXceleratorAccounts,
  suggestXceleratorAccount,
  type QuoteForXcelerator,
} from "@/lib/xcelerator-quote";

// A Model Context Protocol server for what /web-agent does: order lookup
// through the ClientPortal, reply drafting, quote reading and pricing, and
// saving quotes in Xcelerator. It speaks the Streamable HTTP transport in its
// stateless form (one JSON-RPC message per POST, answered with JSON), which
// every MCP client supports and which suits serverless functions.
//
// The tools call the same library functions the /api/web-agent/* routes do.

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "xcelerator-web-agent", version: "0.1.0" };

type Json = Record<string, unknown>;

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Json) => Promise<unknown>;
};

/** An error the tool reports back to the model (isError), rather than a protocol error. */
class ToolError extends Error {}

// ---------- argument helpers ----------

function str(args: Json, key: string, max: number, required = false): string {
  const v = args[key];
  const s = typeof v === "string" ? v.trim().slice(0, max) : "";
  if (required && !s) throw new ToolError(`"${key}" is required.`);
  return s;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function readEmail(value: unknown): InquiryEmail | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Json;
  if (typeof e.body !== "string" || !e.body.trim()) return null;
  return {
    subject: typeof e.subject === "string" ? e.subject : "",
    from: typeof e.from === "string" ? e.from : "",
    fromName: typeof e.fromName === "string" ? e.fromName : undefined,
    body: e.body,
  };
}

function readThread(value: unknown): ThreadMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 10)
    .map((m): ThreadMessage | null => {
      if (!m || typeof m !== "object") return null;
      const r = m as Json;
      const text = typeof r.text === "string" ? r.text.trim().slice(0, 2500) : "";
      if (!text) return null;
      return {
        from: typeof r.from === "string" ? r.from.slice(0, 200) : "",
        sentAt: typeof r.sentAt === "string" && !Number.isNaN(Date.parse(r.sentAt)) ? r.sentAt : null,
        text,
      };
    })
    .filter((m): m is ThreadMessage => m !== null);
}

function requireBackOffice(): void {
  if (!isXceleratorQuoteConfigured()) {
    throw new ToolError(
      "Xcelerator's back office isn't connected (set XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD).",
    );
  }
}

function quoteForXcelerator(args: Json): QuoteForXcelerator {
  const inputs = readQuoteInputs(args.inputs);
  if (!inputs) throw new ToolError("\"inputs\" is missing or incomplete; see the tool's input schema.");
  return {
    accountNo: str(args, "accountNo", 20, true),
    inputs,
    quote: calculateQuote(inputs),
    pickupAddress: str(args, "pickupAddress", 300, true),
    deliveryAddress: str(args, "deliveryAddress", 300, true),
    pieces: count(args.pieces),
    pallets: count(args.pallets),
    callerName: str(args, "callerName", 75),
  };
}

// ---------- schemas ----------

const emailSchema = {
  type: "object",
  description: "The customer's email.",
  properties: {
    subject: { type: "string" },
    from: { type: "string", description: "Sender email address." },
    fromName: { type: "string" },
    body: { type: "string", description: "Plain-text body." },
  },
  required: ["body"],
};

const quoteInputsSchema = {
  type: "object",
  description: "The shipment to price on the rate sheet (the quote card's fields).",
  properties: {
    vehicleClass: { type: "string", enum: [...VEHICLE_CLASSES] },
    miles: { type: "number", description: "Driving miles, e.g. from route_miles." },
    weight: { type: "number", description: "Total weight in pounds." },
    vehicleCapacityLb: { type: ["number", "null"], description: "Cargo capacity in lb; needed for every vehicle but box-truck (fixed at 9,000)." },
    pickupStart: { type: "string", description: "Atlanta wall-clock time, YYYY-MM-DDTHH:mm." },
    deliveryEnd: { type: "string", description: "Atlanta wall-clock time, YYYY-MM-DDTHH:mm." },
    fuelPercent: { type: "number", description: "Fuel surcharge percent, e.g. from fuel_surcharge." },
    fuelBasis: { type: "string", enum: ["transport", "subtotal"] },
    trip: { type: "string", enum: [...TRIPS] },
    extras: { type: "array", items: { type: "string", enum: [...QUOTE_EXTRAS] } },
    dryIcePounds: { type: "number" },
    pickupWaitMinutes: { type: "number" },
    deliveryWaitMinutes: { type: "number" },
    additionalDeliveryAttempts: { type: "number" },
    airportRecoveryAttempts: { type: "number" },
    helperHours: { type: "number" },
    helperHourlyRate: { type: ["number", "null"] },
  },
  required: ["vehicleClass", "miles", "weight", "pickupStart", "deliveryEnd", "fuelPercent", "fuelBasis", "trip"],
};

const xceleratorQuoteSchema = {
  type: "object",
  properties: {
    accountNo: { type: "string", description: "Xcelerator AccountNo, e.g. from suggest_xcelerator_account." },
    inputs: quoteInputsSchema,
    pickupAddress: { type: "string" },
    deliveryAddress: { type: "string" },
    pieces: { type: "number" },
    pallets: { type: "number" },
    callerName: { type: "string", description: "Who asked for the quote; saved as its caller." },
  },
  required: ["accountNo", "inputs", "pickupAddress", "deliveryAddress"],
};

// ---------- tools ----------

const TOOLS: Tool[] = [
  {
    name: "find_order",
    title: "Find order",
    description:
      "Looks up an Xcelerator order by reference number (PO, HAWB, BOL, etc.) the way /web-agent does: a browser signs in to the ClientPortal as each caller and searches Quick Track. Can take one to several minutes. Returns the order, the caller and account it was found under, its orderTrackingId and the steps taken.",
    inputSchema: {
      type: "object",
      properties: { referenceNumber: { type: "string", description: "The reference number, e.g. 212620423M." } },
      required: ["referenceNumber"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const referenceNumber = str(args, "referenceNumber", 100, true);
      try {
        const result = await findOrderWithWebAgent(referenceNumber);
        // Callers still finishing hand their pages back; wait so the function isn't cut short.
        if (result.background) await result.background.catch(() => undefined);
        return {
          found: Boolean(result.order),
          order: result.order,
          foundViaCaller: result.foundViaCaller,
          account: result.account,
          orderTrackingId: result.orderTrackingId,
          reviewOrderUrl: result.orderTrackingId ? reviewOrderUrl(result.orderTrackingId) : null,
          warning: result.warning,
          steps: result.steps,
        };
      } catch (err) {
        if (err instanceof WebAgentError) throw new ToolError(`${err.message} (status ${err.status})`);
        throw err;
      }
    },
  },
  {
    name: "draft_order_reply",
    title: "Draft order reply",
    description:
      "Drafts the reply to a customer about their order, from the order find_order returned. Pass the customer's email to answer it directly. Returns the reply text and any questions the customer asked that the order doesn't answer.",
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "object", description: "The `order` object from find_order." },
        email: emailSchema,
      },
      required: ["order"],
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const order = args.order as OrderInquiry | undefined;
      if (!order || typeof order !== "object" || typeof order.referenceNumber !== "string") {
        throw new ToolError("\"order\" must be the order object from find_order.");
      }
      return draftReplyFromOrder(order, readEmail(args.email));
    },
  },
  {
    name: "list_order_documents",
    title: "List order documents",
    description: "Lists the documents already attached to an Xcelerator order, through the caller's ClientPortal login.",
    inputSchema: {
      type: "object",
      properties: {
        orderTrackingId: { type: "string", description: "From find_order." },
        caller: { type: "string", description: "foundViaCaller from find_order." },
      },
      required: ["orderTrackingId", "caller"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      return { documents: await listOrderDocuments(str(args, "caller", 200, true), str(args, "orderTrackingId", 50, true)) };
    },
  },
  {
    name: "detect_quote_request",
    title: "Detect quote request",
    description:
      "Says whether an email asks for a price quote and reads the shipment details it gives (places, weight, pieces, vehicle, times). Optionally include earlier messages of the thread.",
    inputSchema: {
      type: "object",
      properties: {
        email: emailSchema,
        thread: {
          type: "array",
          description: "Earlier messages in the thread, newest last.",
          items: {
            type: "object",
            properties: { from: { type: "string" }, sentAt: { type: "string" }, text: { type: "string" } },
            required: ["text"],
          },
        },
      },
      required: ["email"],
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const email = readEmail(args.email);
      if (!email) throw new ToolError("\"email.body\" is required.");
      return { detection: await detectQuoteRequest(email, { thread: readThread(args.thread), documents: [] }) };
    },
  },
  {
    name: "route_miles",
    title: "Route miles",
    description: "Driving miles and minutes between a pickup and a delivery place, from Google Maps.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async run(args) {
      return routeMiles(str(args, "from", 300, true), str(args, "to", 300, true));
    },
  },
  {
    name: "fuel_surcharge",
    title: "Fuel surcharge",
    description:
      "The fuel surcharge Xcelerator currently assigns for each vehicle for this sender and route, plus the defaults. Reading it reserves and releases an order number in Xcelerator, as opening Order Entry does.",
    inputSchema: {
      type: "object",
      properties: {
        senderEmail: { type: "string" },
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
        day: { type: "string", description: "YYYY-MM-DD; defaults to today in Atlanta." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(str(args, "day", 10)) ? str(args, "day", 10) : undefined;
      const assignment = await fuelAssignmentFor(
        str(args, "senderEmail", 200),
        [str(args, "pickupAddress", 300) || null, str(args, "deliveryAddress", 300) || null],
        day,
      );
      return { fuel: assignment.xcelerator, defaults: assignment.defaults, reason: assignment.unavailable ?? undefined };
    },
  },
  {
    name: "calculate_quote",
    title: "Calculate quote",
    description:
      "Prices a shipment on the rate sheet and drafts the reply giving the customer that price. Nothing is saved.",
    inputSchema: {
      type: "object",
      properties: {
        inputs: quoteInputsSchema,
        email: emailSchema,
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
      },
      required: ["inputs"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args) {
      const inputs = readQuoteInputs(args.inputs);
      if (!inputs) throw new ToolError("\"inputs\" is missing or incomplete; see the tool's input schema.");
      const quote = calculateQuote(inputs);
      const reply = await draftQuoteReply(readEmail(args.email), quote, inputs, {
        pickupAddress: str(args, "pickupAddress", 300) || null,
        deliveryAddress: str(args, "deliveryAddress", 300) || null,
      });
      return { quote, reply };
    },
  },
  {
    name: "search_xcelerator_accounts",
    title: "Search Xcelerator accounts",
    description: "Xcelerator accounts whose company name or account number starts with the text.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async run(args) {
      requireBackOffice();
      return { accounts: await searchXceleratorAccounts(str(args, "q", 100, true)) };
    },
  },
  {
    name: "suggest_xcelerator_account",
    title: "Suggest Xcelerator account",
    description: "The sender's Xcelerator account when their email domain points at one, plus other likely accounts.",
    inputSchema: {
      type: "object",
      properties: {
        senderEmail: { type: "string" },
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
      },
      required: ["senderEmail"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async run(args) {
      requireBackOffice();
      return suggestXceleratorAccount(str(args, "senderEmail", 200, true), [
        str(args, "pickupAddress", 300) || null,
        str(args, "deliveryAddress", 300) || null,
      ]);
    },
  },
  {
    name: "preview_xcelerator_quote",
    title: "Preview Xcelerator quote",
    description:
      "Works out everything a quote would be saved with in Xcelerator (account, addresses, vehicle, charges) without saving it. Reserves an order number in Xcelerator.",
    inputSchema: xceleratorQuoteSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      requireBackOffice();
      return { plan: await previewXceleratorQuote(quoteForXcelerator(args)) };
    },
  },
  {
    name: "save_xcelerator_quote",
    title: "Save Xcelerator quote",
    description:
      "Saves the quote in Xcelerator as a quote (\"Q...\"). This writes to Xcelerator: preview it first and only save when the user confirms.",
    inputSchema: xceleratorQuoteSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args) {
      requireBackOffice();
      return { saved: await saveXceleratorQuote(quoteForXcelerator(args)) };
    },
  },
  {
    name: "web_agent_memory",
    title: "Web agent memory",
    description:
      "What the web agent has learned about where reference numbers live. With `ref`, also the order it would search callers and Quick Track fields in, and where that reference was found before.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } } },
    annotations: { readOnlyHint: true },
    async run(args) {
      const ref = str(args, "ref", 100);
      const memory = await loadMemory({ fresh: true });
      const summary = {
        storage: memoryBackend(),
        callers: memory.callers,
        typeCallers: memory.typeCallers ?? {},
        recentEpisodes: memory.episodes.slice(-10),
        rememberedReferences: Object.keys(memory.places ?? {}).length,
      };
      if (!ref) return summary;
      const context = referenceContext(ref);
      const callers = xceleratorCallersFromEnv().map((c) => c.label);
      return {
        ...summary,
        ref,
        shape: context.shape,
        foundBefore: rememberedPlace(memory, ref),
        callerOrder: rankCallers(memory, context, callers),
        plan: rankTrackBy(memory, context, listFieldsFor(ref)),
      };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- JSON-RPC ----------

type RpcId = string | number | null;
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: Json };

const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(params: Json | undefined) {
  const name = typeof params?.name === "string" ? params.name : "";
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return null;
  const args = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Json) : {};
  try {
    const value = await tool.run(args);
    const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : { value };
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
  } catch (err) {
    // The libraries' own errors carry an HTTP status; under 500 means bad input, not a failure here.
    const status = (err as { status?: unknown }).status;
    const expected = err instanceof ToolError || (typeof status === "number" && status < 500);
    if (!expected) console.error(`MCP tool ${name} failed:`, err);
    const message = err instanceof Error ? err.message : "The tool failed.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Answers one JSON-RPC message; null for a notification (no answer is sent). */
export async function handleMcpMessage(message: RpcMessage): Promise<Json | null> {
  const id = message.id ?? null;
  const isRequest = message.id !== undefined && message.id !== null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(id, -32600, "Invalid request");
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...

  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Tools for Skyline's Xcelerator web agent. To answer an order inquiry: find_order, then draft_order_reply. To quote: detect_quote_request, route_miles, fuel_surcharge, calculate_quote; to put the quote in Xcelerator: suggest_xcelerator_account, preview_xcelerator_quote, then save_xcelerator_quote only after the user confirms.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const result = await callTool(message.params);
      return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${String(message.params?.name)}`);
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
