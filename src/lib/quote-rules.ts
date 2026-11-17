// Reads shipment details out of a quote-request email with plain text rules,
// no AI. Used to fill whatever the AI left empty, and on its own when OpenAI
// is unavailable. Only what the email states is taken; nothing is estimated.

import type { QuoteExtra, QuoteRequestFields, Trip, VehicleClass } from "./quote-types";

const LB_PER_KG = 2.20462;
const MILES_PER_KM = 0.621371;

/** The newest message only: quoted replies and forwarded headers below it describe older shipments. */
function newestMessage(body: string): string {
  const cut = body.search(
    /^\s*(?:On .{0,200}wrote:|-{2,}\s*Original Message|_{5,}|From:\s.*@|Sent from my |El .{0,200}escribi[oó]:)/im,
  );
  return (cut > 0 ? body.slice(0, cut) : body).replace(/\r\n?/g, "\n");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

// ── Locations ────────────────────────────────────────────────────────────────

// Where an inline place name ends: sentence punctuation, a new line, or a word
// that starts the next detail ("… Atlanta GA tomorrow at 9am", "… Norcross by 11").
const PLACE_END =
  String.raw`(?=\s*(?:[.;!?](?:\s|$)|\n|$|\(|\s(?:by|before|from|at\s+(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m|o'?clock)|noon|midnight)|on\s+(?:mon|tue|wed|thu|fri|sat|sun|\d)|tomorrow|today|tonight|asap|this\s|next\s|for\s|and\s+(?:then\s+)?(?:deliver|drop|back|return)|deliver|drop|going|then|it'?s|they|we|please|thanks|with|weighing|approx|around|about|ma(?:ñ|n)ana|hoy|para|por\s+favor|gracias|\d{1,2}(?::\d{2})?\s*[ap]\.?m)\b|,\s*(?:deliver|drop|going|then|by|before|tomorrow|today|asap|it'?s|please|thanks)\b))`;

// A place name: one line, and it does not run past the end of a sentence
// (". Round trip…"), though "St. NE" style abbreviations are fine.
const PLACE = String.raw`((?:[^\n?!;.]|\.(?!\s+[A-Z][a-z])){3,160}?)`;

const INLINE_PAIRS: RegExp[] = [
  // "from Piedmont Hospital to LabCorp in Norcross"
  new RegExp(String.raw`\bfrom\s+(?!me\b|us\b|you\b)${PLACE}\s+(?:to|->|→|till)\s+${PLACE}${PLACE_END}`, "i"),
  // "desde Duluth hasta Alpharetta"
  new RegExp(String.raw`\bdesde\s+${PLACE}\s+(?:hasta|a)\s+${PLACE}${PLACE_END}`, "i"),
];

const INLINE_PICKUP: RegExp[] = [
  new RegExp(String.raw`\bpick(?:ing|ed)?\s*-?\s*up\s+(?:is\s+|will\s+be\s+)?(?:at|from|in)\s+${PLACE}${PLACE_END}`, "i"),
  new RegExp(String.raw`\bcollect(?:ion|ing)?\s+(?:at|from)\s+${PLACE}${PLACE_END}`, "i"),
  new RegExp(String.raw`\brecog(?:er|ida)\s+(?:en|de|desde)\s+${PLACE}${PLACE_END}`, "i"),
  // "… to Savannah GA from our warehouse at 120 Main St, Decatur GA"
  new RegExp(String.raw`\bfrom\s+(?!me\b|us\b|you\b)${PLACE}${PLACE_END}`, "i"),
];

const INLINE_DELIVERY: RegExp[] = [
  new RegExp(String.raw`\bdeliver(?:ing|y|ed)?\s+(?:it\s+|them\s+|is\s+|will\s+be\s+)?(?:to|at|in)\s+${PLACE}${PLACE_END}`, "i"),
  new RegExp(String.raw`\bdrop(?:ping|ped)?\s*-?\s*(?:it\s+|them\s+)?off\s+(?:at|to|in)\s+${PLACE}${PLACE_END}`, "i"),
  new RegExp(String.raw`\b(?:going|headed|heading)\s+to\s+${PLACE}${PLACE_END}`, "i"),
  new RegExp(String.raw`\bentreg(?:ar|a|ado)\s+(?:en|a)\s+${PLACE}${PLACE_END}`, "i"),
];

const PICKUP_LABEL =
  /^\s*(?:\*\s*)?(?:pick\s*-?\s*up|p\/u|origin|shipper|ship(?:ping)?\s+from|collect(?:ion)?\s+from|from|recogida|origen)(?:\s+(?:address|location|site|info))?\s*[:\-–]\s*(.*)$/i;
const DELIVERY_LABEL =
  /^\s*(?:\*\s*)?(?:deliver(?:y|\s+to)?|drop\s*-?\s*off|d\/o|destination|consignee|receiver|ship(?:ping)?\s+to|to|entrega|destino)(?:\s+(?:address|location|site|info))?\s*[:\-–]\s*(.*)$/i;
const ANY_LABEL = /^\s*(?:\*\s*)?[A-Za-z][A-Za-z /#&-]{0,30}:\s/;

/** A "Pickup: …" style block: the text after the label plus up to three address lines under it. */
function labeled(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const next = lines[j].trim();
      if (!next || ANY_LABEL.test(next)) break;
      parts.push(next);
    }
    const value = cleanPlace(parts.filter(Boolean).join(", "));
    // "From: Jane <jane@clinic.com>" is an email header, not a place.
    if (value && !value.includes("@")) return value;
  }
  return null;
}

function cleanPlace(raw: string): string | null {
  const value = raw
    .replace(/\s+/g, " ")
    .replace(/^(?:the|a|an|our|my|el|la)\s+/i, "")
    // "warehouse at 120 Main St, Decatur GA" → the address itself.
    .replace(/^(?:warehouse|office|facility|location|site|building|dock|lab|shop|store|plant)\s+(?:at|on|in)\s+(?=\S*\d)/i, "")
    .replace(/[\s,;:–-]+$/, "")
    .trim();
  if (value.length < 3 || value.length > 200) return null;
  // Not a place: times, dates and amounts ("from 9am to 11am", "from $50 to $80").
  if (/^[\d\s:.,$%/-]*(?:[ap]\.?m\.?)?$/i.test(value)) return null;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|now|asap|morning|afternoon|tonight)\b/i.test(value)) return null;
  return value;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    const value = m ? cleanPlace(m[1]) : null;
    if (value) return value;
  }
  return null;
}

function readLocations(text: string): { pickupAddress: string | null; deliveryAddress: string | null } {
  const lines = text.split("\n");
  let pickupAddress = labeled(lines, PICKUP_LABEL);
  let deliveryAddress = labeled(lines, DELIVERY_LABEL);
  if (!pickupAddress || !deliveryAddress) {
    const flat = text.replace(/\n+/g, "\n");
    for (const pattern of INLINE_PAIRS) {
      const m = pattern.exec(flat);
      const from = m ? cleanPlace(m[1]) : null;
      const to = m ? cleanPlace(m[2]) : null;
      if (from && to) {
        pickupAddress ??= from;
        deliveryAddress ??= to;
        break;
      }
    }
    pickupAddress ??= firstMatch(flat, INLINE_PICKUP);
    deliveryAddress ??= firstMatch(flat, INLINE_DELIVERY);
  }
  return { pickupAddress, deliveryAddress };
}

// ── Amounts ──────────────────────────────────────────────────────────────────

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;

function readDryIce(text: string): number | null {
  const before = new RegExp(String.raw`${NUMBER}\s*(?:lbs?|pounds?|#)\s*(?:of\s+)?dry\s*ice`, "i").exec(text);
  if (before) return round2(toNumber(before[1]));
  const after = new RegExp(String.raw`dry\s*ice[^.\n]{0,25}?${NUMBER}\s*(?:lbs?|pounds?|#)`, "i").exec(text);
  return after ? round2(toNumber(after[1])) : null;
}

function readPieces(text: string): number | null {
  const m = new RegExp(
    String.raw`\b(\d{1,4})\s*(?:x\s*)?(?:pieces?|pcs?|boxes|box|pallets?|skids?|cartons?|totes?|coolers?|packages?|parcels?|cases?|bags?|items?|cajas?|bultos?)\b`,
    "i",
  ).exec(text);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

function readWeight(text: string, pieces: number | null): number | null {
  const pattern = new RegExp(
    String.raw`${NUMBER}\s*(lbs?|pounds?|libras?|#|kgs?|kilos?|kilograms?)(?![a-z])`,
    "gi",
  );
  const found: { lb: number; total: boolean }[] = [];
  for (const m of text.matchAll(pattern)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/^\s*(?:of\s+)?dry\s*ice/i.test(after) || /dry\s*ice[^.\n]*$/i.test(before)) continue;
    // A truck's rating ("26 ft box truck, 10,000 lb capacity") is not the shipment's weight.
    if (/^\s*(?:capacity|max|limit|gvw)/i.test(after)) continue;
    let lb = toNumber(m[1]) * (/^k/i.test(m[2]) ? LB_PER_KG : 1);
    if (pieces && /^\s*(?:each|ea\b|per\s+(?:piece|box|pallet|skid|carton|item|case))/i.test(after)) lb *= pieces;
    if (lb > 0) found.push({ lb: round2(lb), total: /total|in\s+all|combined|overall/i.test(`${before} ${after}`) });
  }
  if (found.length === 0) return null;
  const total = found.find((f) => f.total);
  return total ? total.lb : Math.max(...found.map((f) => f.lb));
}

function readMiles(text: string): number | null {
  const miles = new RegExp(String.raw`${NUMBER}\s*(?:miles?|mi\b|millas?)`, "i").exec(text);
  if (miles) return round2(toNumber(miles[1]));
  const km = new RegExp(String.raw`${NUMBER}\s*(?:km|kms|kilometers?|kil[oó]metros?)\b`, "i").exec(text);
  return km ? round2(toNumber(km[1]) * MILES_PER_KM) : null;
}

// ── Vehicle, trip and extras ─────────────────────────────────────────────────

function readVehicle(text: string): VehicleClass | null {
  if (/\b(?:box\s*truck|straight\s*truck|\d{2}\s*(?:'|ft|foot|feet)\s*(?:box\s*)?truck|lift\s*gate|liftgate)\b/i.test(text)) {
    return "box-truck";
  }
  if (/\b(?:sprinter|cube\s*(?:van|truck)|high\s*roof|extended\s*van)\b/i.test(text)) return "cube-sprinter";
  if (/\b(?:cargo\s*van|van|furgoneta|camioneta)\b/i.test(text)) return "cargo-van";
  if (/\b(?:car|sedan|small\s*package|passenger\s*vehicle|courier\s*car|carro)\b/i.test(text)) return "small-package";
  return null;
}

function readTrip(text: string): Trip | null {
  return /\bround\s*-?\s*trip\b|\bida\s+y\s+vuelta\b/i.test(text) ? "roundtrip" : null;
}

function readExtras(text: string): QuoteExtra[] {
  const extras: QuoteExtra[] = [];
  if (/\b(?:haz\s*mat|hazardous|dangerous\s+goods|un\s*\d{4})\b/i.test(text)) extras.push("hazmat");
  if (/\bdry\s*ice\b[^.\n]{0,30}\b(?:replenish|top\s*off|re-?ice)|\b(?:replenish|re-?ice)[^.\n]{0,30}\bdry\s*ice/i.test(text)) {
    extras.push("dryIceReplenish");
  }
  if (/\b(?:lift\s*gate|liftgate)\b/i.test(text)) extras.push("liftGate");
  if (/\bpallet\s*jack\b/i.test(text)) extras.push("palletJack");
  if (/\bhold\s*(?:it\s+)?over\b/i.test(text)) extras.push("holdOver");
  return extras;
}

/** Shipment details the email states, read by text rules alone. Times are left to the AI or the CSR. */
export function readQuoteFieldsByRules(subject: string, body: string): QuoteRequestFields {
  const text = `${subject}\n${newestMessage(body)}`;
  const pieces = readPieces(text);
  return {
    ...readLocations(newestMessage(body)),
    vehicleClass: readVehicle(text),
    miles: readMiles(text),
    weight: readWeight(text, pieces),
    pieces,
    pickupStart: null,
    deliveryEnd: null,
    trip: readTrip(text),
    extras: readExtras(text),
    dryIcePounds: readDryIce(text),
  };
}

/** The AI's reading, with any field it left empty taken from the text rules. */
export function fillGaps(ai: QuoteRequestFields, rules: QuoteRequestFields): QuoteRequestFields {
  return {
    vehicleClass: ai.vehicleClass ?? rules.vehicleClass,
    miles: ai.miles ?? rules.miles,
    weight: ai.weight ?? rules.weight,
    pieces: ai.pieces ?? rules.pieces,
    pickupAddress: ai.pickupAddress ?? rules.pickupAddress,
    deliveryAddress: ai.deliveryAddress ?? rules.deliveryAddress,
    pickupStart: ai.pickupStart ?? rules.pickupStart,
    deliveryEnd: ai.deliveryEnd ?? rules.deliveryEnd,
    trip: ai.trip ?? rules.trip,
    extras: ai.extras.length > 0 ? ai.extras : rules.extras,
    dryIcePounds: ai.dryIcePounds ?? rules.dryIcePounds,
  };
}
