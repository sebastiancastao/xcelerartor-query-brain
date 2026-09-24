// Learning memory for the web agent: a small multi-armed bandit (the
// simplest form of reinforcement learning) over Quick Track's "track by"
// fields.
//
// Each lookup is an episode. The "arms" are the track-by fields
// (ClientRefNo, OrderTrackingID, ...). The context is the *shape* of the
// reference number (e.g. "1088033" -> "9x7", "REF-1003" -> "Ax3-9x4",
// "105.081826" -> "9x3.9x6"), since references with the same shape tend to
// live in the same field. The reward is 1 when a field finds the order and
// 0 when it was tried first and missed.
//
// Credit assignment: stats are only updated when some caller actually found
// the order. If nobody finds it, it may simply not exist, so the misses tell
// us nothing about which field would have been right, and nothing is learned.
//
// Policy: UCB1 (upper confidence bound). Each field's score is its observed
// hit rate for this shape (blended with a hand-set prior and the all-shapes
// rate) plus an exploration bonus that shrinks as the field gets tried. So
// fields that keep finding orders move to the front. Each lookup searches
// only the top few fields; the last slot sometimes explores a lower-ranked
// field instead, more often after a run of lookups that found nothing (see
// planSearches).
//
// Persistence, first match wins:
//  - Upstash Redis over its REST API, when UPSTASH_REDIS_REST_URL/_TOKEN (or
//    the KV_REST_API_URL/_TOKEN names Vercel's marketplace integration sets)
//    are present. Needed on Vercel, whose functions have no lasting disk.
//  - Otherwise a JSON file (default .data/web-agent-memory.json, gitignored),
//    fine for a long-running server on one machine.

import { promises as fs } from "node:fs";
import path from "node:path";

export type Arm = { tries: number; hits: number; totalMs: number };

export type Episode = {
  at: string;
  shape: string;
  caller: string;
  trackBy: string;
  hit: boolean;
  ms: number;
};

export type WebAgentMemory = {
  version: 1;
  /** shape -> trackBy -> stats */
  shapes: Record<string, Record<string, Arm>>;
  /** trackBy -> stats across every shape */
  global: Record<string, Arm>;
  /** caller label -> how often the order turned up under that caller */
  callers: Record<string, Arm>;
  /** Most recent searches, newest last, capped. */
  episodes: Episode[];
  /**
   * Per shape: how many lookups in a row found nothing, and how often each
   * field has been used as the exploration pick. Drives the exploration slot.
   */
  exploration?: Record<string, { streak: number; tried: Record<string, number> }>;
};

const MAX_EPISODES = 500;
const PRIOR_WEIGHT = 2; // pseudo-tries the prior is worth
const GLOBAL_WEIGHT = 3; // max pseudo-tries borrowed from the all-shapes stats
const EXPLORATION = Number(process.env.WEB_AGENT_EXPLORATION) || 0.35;

function memoryFile(): string {
  return process.env.WEB_AGENT_MEMORY_FILE?.trim() || path.join(process.cwd(), ".data", "web-agent-memory.json");
}

function emptyMemory(): WebAgentMemory {
  return { version: 1, shapes: {}, global: {}, callers: {}, episodes: [] };
}

// --- Storage backends ------------------------------------------------------------

const REDIS_KEY = process.env.WEB_AGENT_MEMORY_KEY?.trim() || "web-agent:memory";

function redisConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function memoryBackend(): "redis" | "file" {
  return redisConfig() ? "redis" : "file";
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

  if (fileCache) return fileCache;
  try {
    fileCache = parseMemory(await fs.readFile(memoryFile(), "utf8"));
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
      const file = memoryFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(memory, null, 1), "utf8");
      await fs.rename(tmp, file);
    })
    .catch((err) => {
      console.warn("[web-agent-memory] could not save:", err instanceof Error ? err.message : err);
    });
  return writeChain;
}

/** "1088033" -> "9x7", "REF-1003" -> "Ax3-9x4", "105.081826" -> "9x3.9x6". */
export function referenceShape(ref: string): string {
  const classes = ref
    .trim()
    .toUpperCase()
    .split("")
    .map((ch) => (/[0-9]/.test(ch) ? "9" : /[A-Z]/.test(ch) ? "A" : ch));
  let out = "";
  for (let i = 0; i < classes.length; ) {
    let j = i;
    while (j < classes.length && classes[j] === classes[i]) j++;
    const run = j - i;
    out += /[9A]/.test(classes[i]) ? `${classes[i]}x${run}` : classes[i].repeat(run);
    i = j;
  }
  return out || "empty";
}

/** Hand-set starting belief, before any lookups have been observed. */
function priorRate(trackBy: string, shape: string): number {
  const looksLikeTrackingId = /^9x\d+\.9x\d+$/.test(shape);
  if (trackBy === "OrderTrackingID") return looksLikeTrackingId ? 0.8 : 0.05;
  if (trackBy === "ClientRefNo") return looksLikeTrackingId ? 0.2 : 0.6;
  return 0.1;
}

export type RankedArm = { trackBy: string; score: number; rate: number; tries: number; hits: number };

/** Orders the track-by fields best-first for this reference shape (UCB1). */
export function rankTrackBy(memory: WebAgentMemory, shape: string, options: readonly string[]): RankedArm[] {
  const shapeArms = memory.shapes[shape] ?? {};
  const totalTries = Object.values(shapeArms).reduce((sum, a) => sum + a.tries, 0);

  return options
    .map((trackBy, order) => {
      const arm = shapeArms[trackBy] ?? { tries: 0, hits: 0, totalMs: 0 };
      const g = memory.global[trackBy];
      const gWeight = g ? Math.min(g.tries, GLOBAL_WEIGHT) : 0;
      const gRate = g && g.tries > 0 ? g.hits / g.tries : 0;
      const prior = priorRate(trackBy, shape);

      const rate =
        (arm.hits + prior * PRIOR_WEIGHT + gRate * gWeight) / (arm.tries + PRIOR_WEIGHT + gWeight);
      const bonus = EXPLORATION * Math.sqrt(Math.log(totalTries + 2) / (arm.tries + 1));
      // Tiny tie-breaker keeps the portal's own order when scores are equal.
      return { trackBy, score: rate + bonus - order * 1e-6, rate, tries: arm.tries, hits: arm.hits };
    })
    .sort((a, b) => b.score - a.score);
}

const EXPLORE_RATE = Number(process.env.WEB_AGENT_EXPLORE_RATE ?? 0.2);
/** Extra exploration chance added per consecutive not-found lookup for a shape. */
const STREAK_BOOST = 0.25;

/**
 * The fields to actually search, best-first, capped at `k`. The first k-1
 * are the top-ranked fields. The last slot is usually the next-ranked one,
 * but sometimes it explores a field from outside the top instead. Without
 * that slot, an order living in a low-ranked field would never be found, and
 * since only finds are learned from, the ranking could never fix itself.
 *
 * The exploration chance starts at EXPLORE_RATE and grows with every lookup
 * in a row that found nothing for this shape (a hint the ranking is wrong).
 * The explored field is the least-explored one so far, so repeated misses
 * cycle through every field instead of re-picking at random. Exploring never
 * adds searches: it only changes which field fills the last slot.
 */
export function planSearches(
  memory: WebAgentMemory,
  shape: string,
  options: readonly string[],
  k: number,
  random: () => number = Math.random,
): { plan: string[]; explored: string | null } {
  const ranked = rankTrackBy(memory, shape, options).map((r) => r.trackBy);
  if (k >= ranked.length) return { plan: ranked, explored: null };
  const plan = ranked.slice(0, k - 1);
  const rest = ranked.slice(k - 1);
  const state = memory.exploration?.[shape];
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

function bump(arm: Arm | undefined, hit: boolean, ms: number): Arm {
  const next = arm ?? { tries: 0, hits: 0, totalMs: 0 };
  return { tries: next.tries + 1, hits: next.hits + (hit ? 1 : 0), totalMs: next.totalMs + ms };
}

export type SearchAttempt = { trackBy: string; hit: boolean; ms: number };

/**
 * Records one finished lookup. `winner` is the caller whose searches found
 * the order, with every search it made in order (misses first, the hit
 * last). Pass null when no caller found it: the episode is logged, but no
 * field is rewarded or penalized.
 */
export async function recordEpisode(params: {
  shape: string;
  winner: { caller: string; attempts: SearchAttempt[] } | null;
  searchedCallers: string[];
  /** The field planSearches picked for its exploration slot, if any. */
  explored?: string | null;
}): Promise<void> {
  const memory = await loadMemory();
  const at = new Date().toISOString();

  const exploration = (memory.exploration ??= {});
  const state = (exploration[params.shape] ??= { streak: 0, tried: {} });
  if (params.explored) state.tried[params.explored] = (state.tried[params.explored] ?? 0) + 1;
  state.streak = params.winner ? 0 : state.streak + 1;

  if (params.winner) {
    const arms = (memory.shapes[params.shape] ??= {});
    for (const attempt of params.winner.attempts) {
      arms[attempt.trackBy] = bump(arms[attempt.trackBy], attempt.hit, attempt.ms);
      memory.global[attempt.trackBy] = bump(memory.global[attempt.trackBy], attempt.hit, attempt.ms);
      memory.episodes.push({ at, shape: params.shape, caller: params.winner.caller, ...attempt });
    }
  } else {
    memory.episodes.push({ at, shape: params.shape, caller: "(none)", trackBy: "-", hit: false, ms: 0 });
  }

  for (const caller of params.searchedCallers) {
    const hit = params.winner?.caller === caller;
    memory.callers[caller] = bump(memory.callers[caller], hit, 0);
  }

  if (memory.episodes.length > MAX_EPISODES) {
    memory.episodes.splice(0, memory.episodes.length - MAX_EPISODES);
  }
  await persist(memory);
}

export async function resetMemory(): Promise<void> {
  const fresh = emptyMemory();
  if (!redisConfig()) fileCache = fresh;
  await persist(fresh);
}
