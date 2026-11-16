// Reads a customer email as a quote request (or not), and drafts the reply
// once Quote Engine has priced it. The model only extracts what the email
// states and words the reply; every dollar figure comes from Quote Engine.

import { emailForPrompt, todayText, type InquiryEmail } from "./agent";
import { chatCompletion, isOpenAIConfigured } from "./openai";
import {
  QUOTE_EXTRAS,
  QUOTE_EXTRA_LABELS,
  TRIPS,
  TRIP_LABELS,
  VEHICLE_CLASSES,
  VEHICLE_LABELS,
  formatCents,
  type QuoteExtra,
  type QuoteInputs,
  type QuoteRequestDetection,
  type QuoteRequestFields,
  type QuoteResult,
  type Trip,
  type VehicleClass,
} from "./quote-types";

// Emails with none of these words are not asking for a price, so opening an
// ordinary status email costs no model call. Deliberately broad (English and
// Spanish): the model makes the actual decision.
const PRICE_WORDS =
  /quot|rate|pric|cost|estimat|how much|charg|fee|cotiza|tarifa|precio|presupuesto|cu[aá]nto/i;

// Without OpenAI (not set up, or its call failed) only an explicit ask counts,
// and nothing is extracted: the CSR fills the whole quote card in.
const EXPLICIT_QUOTE_WORDS = /\b(quotes?|quotation|rate request|estimate|cotizaci[oó]n|presupuesto)\b/i;

const EMPTY_FIELDS: QuoteRequestFields = {
  vehicleClass: null,
  miles: null,
  weight: null,
  pieces: null,
  pickupAddress: null,
  deliveryAddress: null,
  pickupStart: null,
  deliveryEnd: null,
  trip: null,
  extras: [],
  dryIcePounds: null,
};

const NOT_A_QUOTE: QuoteRequestDetection = { isQuoteRequest: false, summary: "", fields: EMPTY_FIELDS };

const DETECT_PROMPT = [
  "You read emails sent to a courier company (medical and freight deliveries around Atlanta) and decide whether the email asks for a price quote.",
  "isQuoteRequest is true only when the sender asks what a NEW delivery or service would cost: a quote, rate, price or estimate for a shipment that is not booked yet.",
  "It is false for questions about an existing order (status, POD, its charges or invoice), for bookings that do not ask for a price, and for marketing or automated emails.",
  "When it is true, extract the shipment details. Use only what the email states. Use null for anything it does not state. Never estimate, and never work out a distance from addresses.",
  "Fields:",
  `vehicleClass: one of ${VEHICLE_CLASSES.join(", ")}, only when the email names the vehicle (car or small package, cargo van, sprinter or cube van, box or straight truck).`,
  "miles: the route distance in miles, only when the email gives a distance.",
  "weight: total weight in pounds (convert kilograms). pieces: number of pieces, boxes or pallets.",
  "pickupAddress and deliveryAddress: as written, as much of the address or place name as the email gives.",
  "pickupStart: when pickup should start. deliveryEnd: the delivery deadline. Both as local Atlanta time in the form YYYY-MM-DDTHH:mm, worked out from today's date given with the email. null when the email gives no time, including when it only says ASAP.",
  `trip: one of ${TRIPS.join(", ")}. roundtrip only when freight is carried in both directions; return for an empty or return-only leg; null when not stated.`,
  `extras: a list with any of ${QUOTE_EXTRAS.join(", ")} the email asks for, else [].`,
  "dryIcePounds: pounds of dry ice requested, else null.",
  "summary: one short sentence saying what the customer wants priced, in English.",
  'Respond with JSON only: {"isQuoteRequest": true or false, "summary": "...", "fields": {"vehicleClass": ..., "miles": ..., "weight": ..., "pieces": ..., "pickupAddress": ..., "deliveryAddress": ..., "pickupStart": ..., "deliveryEnd": ..., "trip": ..., "extras": [...], "dryIcePounds": ...}}.',
].join(" ");

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function wallClock(value: unknown): string | null {
  const m = typeof value === "string" ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value) : null;
  return m ? m[0] : null;
}

function readFields(value: unknown): QuoteRequestFields {
  if (!value || typeof value !== "object") return EMPTY_FIELDS;
  const f = value as Record<string, unknown>;
  return {
    vehicleClass: VEHICLE_CLASSES.includes(f.vehicleClass as VehicleClass) ? (f.vehicleClass as VehicleClass) : null,
    miles: positiveNumber(f.miles),
    weight: positiveNumber(f.weight),
    pieces: positiveNumber(f.pieces),
    pickupAddress: text(f.pickupAddress),
    deliveryAddress: text(f.deliveryAddress),
    pickupStart: wallClock(f.pickupStart),
    deliveryEnd: wallClock(f.deliveryEnd),
    trip: TRIPS.includes(f.trip as Trip) ? (f.trip as Trip) : null,
    extras: Array.isArray(f.extras)
      ? QUOTE_EXTRAS.filter((extra) => (f.extras as unknown[]).includes(extra))
      : [],
    dryIcePounds: positiveNumber(f.dryIcePounds),
  };
}

/** Whether the email asks for a price quote, and the shipment details it states. */
export async function detectQuoteRequest(email: InquiryEmail): Promise<QuoteRequestDetection> {
  const haystack = `${email.subject}\n${email.body}`;
  if (!PRICE_WORDS.test(haystack)) return NOT_A_QUOTE;
  const byWordsOnly: QuoteRequestDetection = EXPLICIT_QUOTE_WORDS.test(haystack)
    ? { isQuoteRequest: true, summary: "", fields: EMPTY_FIELDS }
    : NOT_A_QUOTE;
  if (!isOpenAIConfigured()) return byWordsOnly;

  const now = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  try {
    const res = await chatCompletion({
      messages: [
        { role: "system", content: DETECT_PROMPT },
        {
          role: "user",
          content: `Today is ${todayText()}, ${now} in Atlanta.\n\nEmail:\n"""\n${emailForPrompt(email)}\n"""`,
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: 0,
      maxTokens: 400,
    });
    const data = JSON.parse(res.choices[0]?.message.content ?? "") as Record<string, unknown>;
    if (data.isQuoteRequest !== true) return NOT_A_QUOTE;
    return { isQuoteRequest: true, summary: text(data.summary) ?? "", fields: readFields(data.fields) };
  } catch {
    // OpenAI is down, out of credit, or sent something unreadable: an email
    // that plainly says "quote" still opens the card.
    return byWordsOnly;
  }
}

/** The places the quote runs between, as the email gave them. */
export type QuoteRoute = { pickupAddress: string | null; deliveryAddress: string | null };

function whenText(wall: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return wall;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi)).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function extrasText(extras: QuoteExtra[]): string {
  return extras.map((extra) => QUOTE_EXTRA_LABELS[extra]).join(", ");
}

/** The reply used when OpenAI is not set up or gives nothing usable. */
function templateQuoteReply(quote: QuoteResult, inputs: QuoteInputs, route: QuoteRoute): string {
  const between =
    route.pickupAddress && route.deliveryAddress ? ` from ${route.pickupAddress} to ${route.deliveryAddress}` : "";
  const lines = quote.charges.map(
    (c) => `- ${c.description}: ${formatCents(c.quantity * c.rateCents, quote.currency)}`,
  );
  return [
    "Hi,",
    `Thanks for reaching out. Our quote for this delivery${between} is ${formatCents(quote.totalCents, quote.currency)}.`,
    `That is for a ${VEHICLE_LABELS[inputs.vehicleClass].toLowerCase()}, ${inputs.miles} miles, ${inputs.weight} lb, pickup ${whenText(inputs.pickupStart)} and delivery by ${whenText(inputs.deliveryEnd)}.`,
    lines.join("\n"),
    "Let us know if you'd like to go ahead and we'll get it scheduled.",
    "Thanks,",
  ].join("\n\n");
}

const QUOTE_REPLY_PROMPT = [
  "You are a customer service rep for a courier company, replying to a customer's email that asked for a price quote.",
  "Give the quoted total clearly, then say briefly what it covers: the vehicle, the route when given, and the pickup and delivery times it was priced for.",
  "List the charge lines that make up the total, one per line starting with '- ', with each amount exactly as given. Do not add, drop, round or recompute any amount, and do not mention any price that is not in the quote facts.",
  "If the email asked other questions, answer them only from the quote facts; if the facts don't cover one, say you'll check and follow up.",
  "Say the price is a quote for the details given and may change if they change. Ask the customer to confirm if they want to go ahead. Never say the delivery is booked or scheduled.",
  "Greet the sender by first name if the email or sender name shows it, otherwise 'Hi,'. Reply in the language the email is written in.",
  "Plain text, short paragraphs, no subject line, no markdown, under 170 words. End with a short closing line such as 'Thanks,' and no name, signature or placeholder.",
].join(" ");

/** Drafts the reply that gives the customer the price Quote Engine calculated. */
export async function draftQuoteReply(
  email: InquiryEmail | null,
  quote: QuoteResult,
  inputs: QuoteInputs,
  route: QuoteRoute,
): Promise<string> {
  const fallback = templateQuoteReply(quote, inputs, route);
  if (!isOpenAIConfigured() || !email?.body.trim()) return fallback;

  const facts = {
    total: formatCents(quote.totalCents, quote.currency),
    chargeLines: quote.charges.map((c) => ({
      description: c.description,
      amount: formatCents(c.quantity * c.rateCents, quote.currency),
    })),
    vehicle: VEHICLE_LABELS[inputs.vehicleClass],
    trip: TRIP_LABELS[inputs.trip],
    routeMiles: inputs.miles,
    weightLb: inputs.weight,
    pickupFrom: route.pickupAddress ?? undefined,
    deliverTo: route.deliveryAddress ?? undefined,
    pickupTime: whenText(inputs.pickupStart),
    deliverBy: whenText(inputs.deliveryEnd),
    extras: extrasText(inputs.extras) || undefined,
  };
  try {
    const res = await chatCompletion({
      messages: [
        { role: "system", content: QUOTE_REPLY_PROMPT },
        {
          role: "user",
          content:
            `Today is ${todayText()}.\n\nCustomer email:\n"""\n${emailForPrompt(email)}\n"""\n\n` +
            `Quote facts: ${JSON.stringify(facts)}`,
        },
      ],
      maxTokens: 500,
    });
    const reply = res.choices[0]?.message.content?.trim();
    // A draft that leaves the total out is not worth trusting with the rest.
    return reply && reply.includes(facts.total) ? reply : fallback;
  } catch {
    return fallback;
  }
}
