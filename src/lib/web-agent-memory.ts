// Learning memory for the web agent: a small multi-armed bandit (the
// simplest form of reinforcement learning) over Quick Track's "track by"
// fields, plus a learned order for the callers.
//
// Each lookup is an episode. The context is the *type* of the reference
// number, at two levels:
//  - its shape, digits and letters only counted: "1088033" -> "9x7",
//    "214210851W" -> "9x9Ax1", "105.081826" -> "9x3.9x6";
//  - its taxonomy, which also keeps short letter codes, since those are what
//    tell one numbering scheme from another: "214210851W" -> "9x9W",
//    "212620423M" -> "9x9M", "3853523C" -> "9x7C", "PO-123456" -> "PO-9x6".
//    Without it, every "9 digits plus one letter" reference looked alike,
//    whoever it belonged to.
//
// Two things are learned per type:
//  - which caller has references of this taxonomy (typeCallers). Callers are
//    searched in parallel, but a hit is only accepted once every caller
//    ranked above it has answered, and the top caller wins when several have
//    the order. So the caller that usually has this type goes first. This
//    is keyed by taxonomy alone: the letter code is what tells callers apart,
//    so a find for "9x9M" says nothing about who has "9x9W". A code never
//    seen before falls back to each caller's overall record.
//  - which track-by field each caller keeps it in (callerFields, with the
//    all-callers stats in shapes/global as the fallback). The "arms" are the
//    fields (ClientRefNo, OrderTrackingID, ...); the reward is 1 when a field
//    finds the order and 0 when it was tried first and missed.
//
// Separately, each found reference's exact place (caller and Xcelerator
// account) is remembered in `places`, so looking the same reference up again
// goes straight to the caller that had it.
//
// Since 2026-09-29 the fields are searched in the portal's order list across
// all of a caller's accounts instead of through Quick Track, all of them in
// the learned order until one hits, so the ranking decides speed, not
// whether an order is found. (An "OrderList" arm in older stats is from a
// short-lived version that searched the list by ClientRefNo first.) Each
// caller's account list is kept too (callerAccounts), so callers whose
// accounts another caller already covers aren't searched.
//
// Credit assignment: stats are only updated when some caller actually found
// the order. If nobody finds it, it may simply not exist, so the misses tell
// us nothing, and nothing is learned. A caller that was stopped before it
// finished (because a higher-ranked caller already won) counts as unknown,
// not as a miss; otherwise the top caller would keep "winning" every type.
//
// Policy: UCB1 (upper confidence bound). Each field's score is its observed
// hit rate for this caller and type, backed off to the type, the shape and
// all references in turn (see blendRate), plus an exploration bonus that
// shrinks as the field gets tried. So fields that keep finding orders move
// to the front. Each lookup searches only the top few fields; the last slot
// sometimes explores a lower-ranked field instead, more often after a run of
// lookups that found nothing (see planSearches).
//
// Persistence, first match wins:
//  - Upstash Redis over its REST API, when UPSTASH_REDIS_REST_URL/_TOKEN (or
//    the KV_REST_API_URL/_TOKEN names Vercel's marketplace integration sets)
//    are present. Needed on Vercel, whose functions have no lasting disk.
//  - Supabase, when WEB_AGENT_SUPABASE_URL, WEB_AGENT_SUPABASE_KEY (the
//    project's publishable key) and WEB_AGENT_MEMORY_SECRET are set. The
//    stats live in one row of public.web_agent_memory, a locked table reached
//    only through the web_agent_memory_get/_set database functions, which
//    refuse any caller without the secret (only its SHA-256 is stored in the
//    database). This is what production on Vercel uses.
//  - Otherwise a JSON file (default .data/web-agent-memory.json, gitignored),
//    fine for a long-running server on one machine.

import { promises as fs } from "node:fs";
import path from "node:path";

export type Arm = { tries: number; hits: number; totalMs: number };

export type Episode = {
  at: string;
  shape: string;
  /** Missing on episodes recorded before taxonomies existed. */
  taxonomy?: string;
  caller: string;
  trackBy: string;
  hit: boolean;
  ms: number;
};

export type WebAgentMemory = {
  version: 1;
  /** reference type (shape or taxonomy) -> trackBy -> stats, all callers together */
  shapes: Record<string, Record<string, Arm>>;
  /** trackBy -> stats across every reference type */
  global: Record<string, Arm>;
  /**
   * caller label -> how often that caller had the order, across every type.
   * Counts from before taxonomies existed also scored callers that were only
   * cut off as misses, so they lean toward whichever caller was listed first.
   */
  callers: Record<string, Arm>;
  /** taxonomy -> caller label -> how often that caller had the order */
  typeCallers?: Record<string, Record<string, Arm>>;
  /** caller label -> taxonomy -> trackBy -> stats: where that caller keeps this type of reference */
  callerFields?: Record<string, Record<string, Record<string, Arm>>>;
  /** Most recent searches, newest last, capped. */
  episodes: Episode[];
  /**
   * Per taxonomy: how many lookups in a row found nothing, and how often each
   * field has been used as the exploration pick. Drives the exploration slot.
   */
  exploration?: Record<string, { streak: number; tried: Record<string, number> }>;
  /**
   * Where each recently found reference was found, keyed by the reference
   * upper-cased: which caller had it and in which Xcelerator account. A
   * repeat lookup (the same email opened again, a reply drafted later) goes
   * straight to that caller. Capped at MAX_PLACES, oldest dropped first.
   */
  places?: Record<string, Place>;
  /**
   * The Xcelerator accounts each caller's login can see (codes like
   * "DHLIN"), read from the portal now and then. Seb2 sees seven accounts,
   * including the one each of STRLN and QUKIN sees, so those two only need
   * searching when Seb2 can't be (see planCallerCoverage).
   */
  callerAccounts?: Record<string, { accounts: string[]; at: string }>;
};

export type Place = { caller: string; account: string | null; at: string };

const MAX_EPISODES = 500;
const MAX_PLACES = 1000; // about ten days of Skyline's volume; the whole store is read on every lookup
const PRIOR_WEIGHT = 2; // pseudo-tries the prior is worth
// Max pseudo-tries a broader type lends to a narrower one: one find in a
// different field doesn't overturn what similar references taught, two do.
const PARENT_WEIGHT = 2;
/** Starting belief that a caller has a reference of a type it has never been seen with. */
const CALLER_PRIOR = 0.5;
const EXPLORATION = Number(process.env.WEB_AGENT_EXPLORATION) || 0.35;

function memoryFile(): string {
  return process.env.WEB_AGENT_MEMORY_FILE?.trim() || path.join(process.cwd(), ".data", "web-agent-memory.json");
}

function emptyMemory(): WebAgentMemory {
  return { version: 1, shapes: {}, global: {}, callers: {}, typeCallers: {}, callerFields: {}, episodes: [] };
}

// --- Storage backends ------------------------------------------------------------

const REDIS_KEY = process.env.WEB_AGENT_MEMORY_KEY?.trim() || "web-agent:memory";

function redisConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function supabaseConfig(): { url: string; key: string; secret: string } | null {
  const url = process.env.WEB_AGENT_SUPABASE_URL?.trim();
  const key = process.env.WEB_AGENT_SUPABASE_KEY?.trim();
  const secret = process.env.WEB_AGENT_MEMORY_SECRET?.trim();
  return url && key && secret ? { url: url.replace(/\/+$/, ""), key, secret } : null;
}

export function memoryBackend(): "redis" | "supabase" | "file" {
  if (redisConfig()) return "redis";
  return supabaseConfig() ? "supabase" : "file";
}

/** Calls one of the web_agent_memory_* database functions through Supabase's REST API. */
async function supabaseRpc(
  cfg: { url: string; key: string; secret: string },
  fn: "web_agent_memory_get" | "web_agent_memory_set",
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: cfg.secret, p_key: REDIS_KEY, ...args }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${fn} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function redisCommand(cfg: { url: string; token: string }, command: string[]): Promise<unknown> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!res.ok || body?.error) throw new Error(`Upstash ${command[0]} failed: ${body?.error ?? `HTTP ${res.status}`}`);
  return body?.result;
}

function parseMemory(raw: unknown): WebAgentMemory {
  if (typeof raw !== "string") return emptyMemory();
  try {
    const parsed = JSON.parse(raw) as WebAgentMemory;
    return parsed?.version === 1 ? parsed : emptyMemory();
  } catch {
    return emptyMemory();
  }
}

// The file backend keeps one copy in process memory. Redis is re-read on
// every load, since each serverless instance would otherwise hold its own
// stale copy and overwrite the others' learning.
let fileCache: WebAgentMemory | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadMemory(): Promise<WebAgentMemory> {
  const redis = redisConfig();
  if (redis) {
    try {
      return parseMemory(await redisCommand(redis, ["GET", REDIS_KEY]));
    } catch (err) {
      // Learning is an optimisation: a storage outage must not break lookups.
      console.warn("[web-agent-memory] could not load:", err instanceof Error ? err.message : err);
      return emptyMemory();
    }
  }

  const supabase = supabaseConfig();
  if (supabase) {
    try {
      const value = await supabaseRpc(supabase, "web_agent_memory_get", {});
      return parseMemory(value === null ? null : JSON.stringify(value));
    } catch (err) {
      console.warn("[web-agent-memory] could not load:", err instanceof Error ? err.message : err);
      return emptyMemory();
    }
  }

  if (fileCache) return fileCache;
  try {
    fileCache = parseMemory(await fs.readFile(/*turbopackIgnore: true*/ memoryFile(), "utf8"));
  } catch {
    fileCache = emptyMemory();
  }
  return fileCache;
}

function persist(memory: WebAgentMemory): Promise<void> {
  // Serialize writes so two lookups finishing together in one process can't
  // interleave. (Across serverless instances a rare lost update is possible;
  // for learning statistics that only costs one data point.)
  writeChain = writeChain
    .then(async () => {
      const redis = redisConfig();
      if (redis) {
        await redisCommand(redis, ["SET", REDIS_KEY, JSON.stringify(memory)]);
        return;
      }
      const supabase = supabaseConfig();
      if (supabase) {
        await supabaseRpc(supabase, "web_agent_memory_set", { p_value: memory });
        return;
      }
      const file = memoryFile();
      // The file store is only for local/long-running servers; keep the build
      // tracer from bundling the whole project because of these dynamic paths.
      await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(memory, null, 1), "utf8");
      await fs.rename(/*turbopackIgnore: true*/ tmp, file);
    })
    .catch((err) => {
      console.warn("[web-agent-memory] could not save:", err instanceof Error ? err.message : err);
    });
  return writeChain;
}

// --- Reference types -------------------------------------------------------------

function charClass(ch: string): string {
  return /[0-9]/.test(ch) ? "9" : /[A-Z]/.test(ch) ? "A" : ch;
}

/** Splits an upper-cased reference into runs of the same character class. */
function runs(ref: string): { cls: string; text: string }[] {
  const s = ref.trim().toUpperCase();
  const out: { cls: string; text: string }[] = [];
  for (let i = 0; i < s.length; ) {
    const cls = charClass(s[i]);
    let j = i;
    while (j < s.length && charClass(s[j]) === cls) j++;
    out.push({ cls, text: s.slice(i, j) });
    i = j;
  }
  return out;
}

/** "1088033" -> "9x7", "REF-1003" -> "Ax3-9x4", "105.081826" -> "9x3.9x6". */
export function referenceShape(ref: string): string {
  const out = runs(ref)
    .map((r) => (r.cls === "9" || r.cls === "A" ? `${r.cls}x${r.text.length}` : r.text))
    .join("");
  return out || "empty";
}

/** Letter runs up to this long are kept as literal codes in the taxonomy. */
const MAX_CODE_LETTERS = 4;

/**
 * The reference's shape with its short letter codes kept, since those are
 * what tell numbering schemes (and so callers) apart: "214210851W" ->
 * "9x9W", "212620423M" -> "9x9M", "3853523C" -> "9x7C", "PO-123456" ->
 * "PO-9x6". Longer letter runs stay generic ("Ax7"), since they are more
 * likely words than codes. With no short code it equals the shape.
 *
 * Taxonomy keys never collide with a different shape key: a shape only ever
 * has an "A" when it is followed by a lower-case "x", and a literal code in a
 * taxonomy never is.
 */
export function referenceTaxonomy(ref: string): string {
  const out = runs(ref)
    .map((r) => {
      if (r.cls === "9") return `9x${r.text.length}`;
      if (r.cls === "A") return r.text.length <= MAX_CODE_LETTERS ? r.text : `Ax${r.text.length}`;
      return r.text;
    })
    .join("");
  return out || "empty";
}

export type ReferenceContext = {
  shape: string;
  taxonomy: string;
  /** The types this reference is learned under, broadest first, without repeats. */
  keys: string[];
};

export function referenceContext(ref: string): ReferenceContext {
  const shape = referenceShape(ref);
  const taxonomy = referenceTaxonomy(ref);
  return { shape, taxonomy, keys: taxonomy === shape ? [shape] : [shape, taxonomy] };
}

// --- Ranking ---------------------------------------------------------------------

/** Hand-set starting belief, before any lookups have been observed. */
function priorRate(trackBy: string, shape: string): number {
  const looksLikeTrackingId = /^9x\d+\.9x\d+$/.test(shape);
  if (trackBy === "OrderTrackingID") return looksLikeTrackingId ? 0.8 : 0.05;
  if (trackBy === "ClientRefNo") return looksLikeTrackingId ? 0.2 : 0.6;
  return 0.1;
}

/**
 * Hit rate for the narrowest level of `chain`. The chain runs broadest to
 * narrowest (e.g. every reference, the shape, the taxonomy, one caller's
 * taxonomy) and each level's counts include the next one's. Starting from
 * the prior, each level's own data (minus the next level's, so nothing is
 * counted twice) pulls the estimate toward what it saw. A broader level
 * lends at most PARENT_WEIGHT pseudo-tries to the next, so a handful of
 * finds for this exact kind of reference outweighs hundreds for other kinds,
 * while a kind never seen before still starts from what similar ones taught.
 */
function blendRate(prior: number, chain: (Arm | undefined)[]): number {
  let rate = prior;
  let weight = PRIOR_WEIGHT;
  for (let i = 0; i < chain.length; i++) {
    const own = chain[i];
    const inner = chain[i + 1];
    const tries = Math.max(0, (own?.tries ?? 0) - (inner?.tries ?? 0));
    if (tries === 0) continue;
    const hits = Math.min(tries, Math.max(0, (own?.hits ?? 0) - (inner?.hits ?? 0)));
    const lent = Math.min(weight, PARENT_WEIGHT);
    rate = (hits + rate * lent) / (tries + lent);
    weight = tries + lent;
  }
  return rate;
}

export type RankedArm = { trackBy: string; score: number; rate: number; tries: number; hits: number };

/**
 * Orders the track-by fields best-first for this reference type (UCB1).
 * With a caller, uses where that caller keeps this type first and falls back
 * to all callers; `tries`/`hits` are then that caller's own counts.
 */
export function rankTrackBy(
  memory: WebAgentMemory,
  context: ReferenceContext,
  options: readonly string[],
  caller?: string,
): RankedArm[] {
  const levels: Record<string, Arm>[] = [
    memory.global,
    ...context.keys.map((key) => memory.shapes[key] ?? {}),
    ...(caller ? [memory.callerFields?.[caller]?.[context.taxonomy] ?? {}] : []),
  ];
  const narrowest = levels[levels.length - 1];
  const totalTries = Object.values(narrowest).reduce((sum, a) => sum + a.tries, 0);

  return options
    .map((trackBy, order) => {
      const arm = narrowest[trackBy] ?? { tries: 0, hits: 0, totalMs: 0 };
      const rate = blendRate(
        priorRate(trackBy, context.shape),
        levels.map((level) => level[trackBy]),
      );
      const bonus = EXPLORATION * Math.sqrt(Math.log(totalTries + 2) / (arm.tries + 1));
      // Tiny tie-breaker keeps the portal's own order when scores are equal.
      return { trackBy, score: rate + bonus - order * 1e-6, rate, tries: arm.tries, hits: arm.hits };
    })
    .sort((a, b) => b.score - a.score);
}

export type RankedCaller = {
  caller: string;
  /** Position in the configured caller list. */
  index: number;
  /** Estimated chance this caller has a reference of this type. */
  rate: number;
  /** How often this caller was checked for / had this exact taxonomy. */
  tries: number;
  hits: number;
};

/**
 * Orders the callers by how likely each is to have this type of reference,
 * from which callers had its taxonomy before, else each caller's overall
 * record. Callers with nothing to tell them apart keep the configured list
 * order, so list order is only ever a tie-break.
 */
export function rankCallers(
  memory: WebAgentMemory,
  context: ReferenceContext,
  callers: readonly string[],
): RankedCaller[] {
  return callers
    .map((caller, index) => {
      const chain = [memory.callers[caller], memory.typeCallers?.[context.taxonomy]?.[caller]];
      const own = chain[chain.length - 1];
      return { caller, index, rate: blendRate(CALLER_PRIOR, chain), tries: own?.tries ?? 0, hits: own?.hits ?? 0 };
    })
    .sort((a, b) => b.rate - a.rate || a.index - b.index);
}

const EXPLORE_RATE = Number(process.env.WEB_AGENT_EXPLORE_RATE ?? 0.2);
/** Extra exploration chance added per consecutive not-found lookup for a type. */
const STREAK_BOOST = 0.25;

/**
 * The fields one caller should actually search, best-first, capped at `k`.
 * The first k-1 are the top-ranked fields. The last slot is usually the
 * next-ranked one, but sometimes it explores a field from outside the top
 * instead. Without that slot, an order living in a low-ranked field would
 * never be found, and since only finds are learned from, the ranking could
 * never fix itself.
 *
 * The exploration chance starts at EXPLORE_RATE and grows with every lookup
 * in a row that found nothing for this taxonomy (a hint the ranking is
 * wrong). The explored field is the least-explored one so far, so repeated
 * misses cycle through every field instead of re-picking at random.
 * Exploring never adds searches: it only changes which field fills the last
 * slot. Pass the same `random` to every caller of one lookup so they all
 * explore on the same lookups.
 */
export function planSearches(
  memory: WebAgentMemory,
  context: ReferenceContext,
  options: readonly string[],
  k: number,
  caller?: string,
  random: () => number = Math.random,
): { plan: string[]; explored: string | null } {
  const ranked = rankTrackBy(memory, context, options, caller).map((r) => r.trackBy);
  if (k >= ranked.length) return { plan: ranked, explored: null };
  const plan = ranked.slice(0, k - 1);
  const rest = ranked.slice(k - 1);
  const state = memory.exploration?.[context.taxonomy];
  const chance = Math.min(1, EXPLORE_RATE + STREAK_BOOST * (state?.streak ?? 0));

  if (rest.length > 1 && random() < chance) {
    const candidates = rest.slice(1);
    const tried = state?.tried ?? {};
    const fewest = Math.min(...candidates.map((c) => tried[c] ?? 0));
    const pick = candidates.find((c) => (tried[c] ?? 0) === fewest)!;
    return { plan: [...plan, pick], explored: pick };
  }
  return { plan: [...plan, rest[0]], explored: null };
}

function placeKey(ref: string): string {
  return ref.trim().toUpperCase();
}

/** Where this exact reference was found last time, if it was found before. */
export function rememberedPlace(memory: WebAgentMemory, ref: string): Place | null {
  return memory.places?.[placeKey(ref)] ?? null;
}

// --- Which callers to search ------------------------------------------------------

/** How long a caller's account list is trusted before it is read again. */
const ACCOUNT_LIST_MAX_AGE_MS = 24 * 60 * 60_000;

/** Whether this caller's account list is missing or old enough to read again. */
export function accountListIsStale(memory: WebAgentMemory, caller: string): boolean {
  const known = memory.callerAccounts?.[caller];
  return !known?.accounts.length || Date.now() - Date.parse(known.at) > ACCOUNT_LIST_MAX_AGE_MS;
}

/**
 * Splits the callers into the ones to search and backups. Each caller's
 * order-list search covers every account it can see, so a caller whose
 * accounts are all seen by the callers already picked adds nothing. Picks
 * the caller that adds the most unseen accounts, then the next, and so on
 * (ties go to the higher-ranked caller); the rest are backups, searched
 * only if a picked caller fails. A caller whose account list is unknown or
 * stale is always picked, so its list gets read. Both lists keep `ranked`'s
 * order.
 */
export function planCallerCoverage(
  memory: WebAgentMemory,
  ranked: readonly string[],
): { search: string[]; backup: string[] } {
  const picked = new Set(ranked.filter((c) => accountListIsStale(memory, c)));
  const seen = new Set<string>();
  let candidates = ranked.filter((c) => !picked.has(c));
  for (;;) {
    let best: string | null = null;
    let bestGain = 0;
    for (const c of candidates) {
      const gain = (memory.callerAccounts?.[c]?.accounts ?? []).filter((a) => !seen.has(a)).length;
      if (gain > bestGain) {
        best = c;
        bestGain = gain;
      }
    }
    if (!best) break;
    picked.add(best);
    for (const a of memory.callerAccounts?.[best]?.accounts ?? []) seen.add(a);
    candidates = candidates.filter((c) => c !== best);
  }
  return { search: ranked.filter((c) => picked.has(c)), backup: ranked.filter((c) => !picked.has(c)) };
}

// --- Recording -------------------------------------------------------------------

function bump(arm: Arm | undefined, hit: boolean, ms: number): Arm {
  const next = arm ?? { tries: 0, hits: 0, totalMs: 0 };
  return { tries: next.tries + 1, hits: next.hits + (hit ? 1 : 0), totalMs: next.totalMs + ms };
}

export type SearchAttempt = { trackBy: string; hit: boolean; ms: number };

export type CallerOutcome = {
  caller: string;
  /**
   * true: this caller had the order. false: it finished its searches without
   * finding it. null: unknown, because it failed or was stopped early once a
   * higher-ranked caller had already won.
   */
  found: boolean | null;
  /** Every search it made, in order (misses first, the hit last). Only needed when found. */
  attempts: SearchAttempt[];
};

/**
 * Records one finished lookup. `outcomes` is what each caller had answered
 * by the time the winner was settled. When nobody found the order, the
 * episode is logged but nothing is rewarded or penalized.
 */
export async function recordEpisode(params: {
  context: ReferenceContext;
  /** Label of the caller whose result was used, or null when nobody found the order. */
  winner: string | null;
  outcomes: CallerOutcome[];
  /** Fields planSearches picked for exploration slots in this lookup. */
  explored?: string[];
  /** The reference that was found and where, remembered for repeat lookups. */
  found?: { ref: string; caller: string; account: string | null };
  /** Account lists read from the portal during this lookup, by caller. */
  accounts?: Record<string, string[]>;
}): Promise<void> {
  const memory = await loadMemory();
  const at = new Date().toISOString();
  const { shape, taxonomy, keys } = params.context;

  const exploration = (memory.exploration ??= {});
  const state = (exploration[taxonomy] ??= { streak: 0, tried: {} });
  for (const field of new Set(params.explored ?? [])) state.tried[field] = (state.tried[field] ?? 0) + 1;
  state.streak = params.winner ? 0 : state.streak + 1;

  if (params.winner) {
    const typeCallers = (memory.typeCallers ??= {});
    const callerFields = (memory.callerFields ??= {});
    for (const outcome of params.outcomes) {
      if (outcome.found === null) continue; // stopped early or failed: unknown, not a miss
      memory.callers[outcome.caller] = bump(memory.callers[outcome.caller], outcome.found, 0);
      const row = (typeCallers[taxonomy] ??= {});
      row[outcome.caller] = bump(row[outcome.caller], outcome.found, 0);
      // Only a caller that had the order says anything about which field it is in.
      if (!outcome.found) continue;
      const own = ((callerFields[outcome.caller] ??= {})[taxonomy] ??= {});
      for (const attempt of outcome.attempts) {
        memory.global[attempt.trackBy] = bump(memory.global[attempt.trackBy], attempt.hit, attempt.ms);
        for (const key of keys) {
          const arms = (memory.shapes[key] ??= {});
          arms[attempt.trackBy] = bump(arms[attempt.trackBy], attempt.hit, attempt.ms);
        }
        own[attempt.trackBy] = bump(own[attempt.trackBy], attempt.hit, attempt.ms);
        memory.episodes.push({ at, shape, taxonomy, caller: outcome.caller, ...attempt });
      }
    }
  } else {
    memory.episodes.push({ at, shape, taxonomy, caller: "(none)", trackBy: "-", hit: false, ms: 0 });
  }

  if (memory.episodes.length > MAX_EPISODES) {
    memory.episodes.splice(0, memory.episodes.length - MAX_EPISODES);
  }

  for (const [caller, accounts] of Object.entries(params.accounts ?? {})) {
    (memory.callerAccounts ??= {})[caller] = { accounts, at };
  }

  if (params.found) {
    const places = (memory.places ??= {});
    places[placeKey(params.found.ref)] = { caller: params.found.caller, account: params.found.account, at };
    // Oldest dropped by date: most references are plain numbers, and objects
    // list number-like keys in numeric order, not the order they were added.
    const excess = Object.keys(places).length - MAX_PLACES;
    if (excess > 0) {
      const oldest = Object.entries(places)
        .sort((a, b) => a[1].at.localeCompare(b[1].at))
        .slice(0, excess);
      for (const [key] of oldest) delete places[key];
    }
  }
  await persist(memory);
}

export async function resetMemory(): Promise<void> {
  const fresh = emptyMemory();
  if (!redisConfig()) fileCache = fresh;
  await persist(fresh);
}
