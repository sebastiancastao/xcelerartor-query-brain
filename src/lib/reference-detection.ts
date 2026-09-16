// Detects order/reference-number candidates inside a pasted customer email so
// the CSR doesn't have to hunt for the ID by hand. Pattern-based (regex) by
// design: Xcelerator reference formats are deterministic (REF-####, PO-####,
// INV-####, and the dotted OrderTrackingID like 105.081826), so a fast,
// dependency-free matcher beats an LLM round-trip for this. The scoring
// scheme leaves room to slot in a fuzzier fallback (e.g. an LLM pass) later
// for emails that don't match any pattern, without changing the call sites.
//
// This only ever *detects* — callers decide what to do with the result. The
// UI uses it to pre-fill the search box, never to auto-submit a lookup.

export type DetectedReference = {
  /** The candidate value as found in the text (original casing preserved). */
  value: string;
  /** Rough confidence, 0-1 — higher means "looks more like a real ID". */
  confidence: number;
  /** Short human-readable reason, shown as a tooltip/label in the UI. */
  reason: string;
  /** Index into the source text where the match starts, for stable ordering. */
  index: number;
};

type PatternRule = {
  pattern: RegExp;
  confidence: number;
  reason: string;
  /** Which capture group holds the ID value (0 = whole match). */
  group?: number;
};

// Stage 1 — explicit Xcelerator ID shapes. These are distinctive enough that
// a match is almost certainly a real reference, not incidental text.
const KNOWN_FORMAT_RULES: PatternRule[] = [
  {
    pattern: /\bREF-\d{3,}\b/gi,
    confidence: 0.97,
    reason: "Matches REF-#### reference format",
  },
  {
    pattern: /\bINV-\d{3,}\b/gi,
    confidence: 0.9,
    reason: "Matches INV-#### invoice format",
  },
  {
    pattern: /\bPO-\d{3,}\b/gi,
    confidence: 0.85,
    reason: "Matches PO-#### purchase-order format",
  },
  {
    // Xcelerator's numeric OrderTrackingID is rendered as e.g. "105.081826"
    // (an integer, a dot, then exactly six digits) — see
    // formatOrderTrackingId() in xcelerator.ts.
    pattern: /\b\d{1,10}\.\d{6}\b/g,
    confidence: 0.92,
    reason: "Matches numeric order-tracking ID format (#.######)",
  },
];

// Stage 2 — a label the CSR's customer wrote next to their own ID, e.g.
// "Order #: 48213", "Reference number - ABC-991", "Tracking# 12345".
// Broad on purpose (real-world emails are inconsistent), so every candidate
// pulled this way is validated by looksLikeId() below before being kept.
const LABELED_ID_PATTERN =
  /\b(?:order|reference|ref|tracking|invoice|shipment|pro|awb|client\s*ref(?:erence)?)\b(?:\s*(?:number|no\.?|id))?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9./-]{2,24})/gi;
const LABELED_ID_CONFIDENCE = 0.72;
const LABELED_ID_REASON = "Follows an order/reference/tracking label";

// Words that legitimately follow "order"/"reference" in ordinary prose and
// would otherwise look like a candidate (has a digit-adjacent shape) — kept
// short since the digit requirement in looksLikeId() already rejects most
// plain words.
const STOPWORD_VALUES = new Set(["id", "no", "number", "num", "#"]);

function looksLikeId(raw: string): boolean {
  const value = raw.replace(/[.,;:]+$/, "").trim();
  if (value.length < 3 || value.length > 24) return false;
  if (STOPWORD_VALUES.has(value.toLowerCase())) return false;

  const hasDigit = /\d/.test(value);
  if (!hasDigit) return false;

  const hasLetter = /[A-Za-z]/.test(value);
  const hasSeparator = /[-./]/.test(value);
  // A bare number needs to be long enough (5+ digits) or carry a separator/
  // letter to avoid matching a bare year ("2024") or small incidental count.
  if (!hasLetter && !hasSeparator && value.length < 5) return false;

  return true;
}

function cleanValue(raw: string): string {
  return raw.replace(/[.,;:]+$/, "").trim();
}

/**
 * Scans free-form email text (subject + body, or just body) for candidate
 * order/reference numbers. Returns candidates sorted by confidence (desc),
 * then by first appearance — so index 0 is the best guess to pre-fill.
 */
export function detectOrderReferences(text: string): DetectedReference[] {
  if (!text || !text.trim()) return [];

  const found = new Map<string, DetectedReference>();

  function record(value: string, confidence: number, reason: string, index: number) {
    const key = value.toUpperCase();
    const existing = found.get(key);
    if (!existing || confidence > existing.confidence) {
      found.set(key, { value, confidence, reason, index });
    }
  }

  for (const rule of KNOWN_FORMAT_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[rule.group ?? 0];
      const value = cleanValue(raw);
      if (value) record(value, rule.confidence, rule.reason, match.index);
      if (!re.global) break;
    }
  }

  {
    const re = new RegExp(LABELED_ID_PATTERN.source, LABELED_ID_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1];
      if (raw && looksLikeId(raw)) {
        record(cleanValue(raw), LABELED_ID_CONFIDENCE, LABELED_ID_REASON, match.index);
      }
    }
  }

  return Array.from(found.values())
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
    .slice(0, 5);
}

/** Convenience: the single best candidate, or null if nothing was found. */
export function bestOrderReference(text: string): DetectedReference | null {
  return detectOrderReferences(text)[0] ?? null;
}
