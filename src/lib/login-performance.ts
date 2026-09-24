// Lightweight, self-tuning performance tracking for the external logins
// this app calls (each Xcelerator ClientPortal login, plus the Axis REST
// API as its own "login"). NOT machine learning in the formal sense — no
// reward function, no trained policy, no episodes to learn across. That
// machinery doesn't fit a request/response lookup tool, and there's no
// natural reward signal to train against here. What this DOES do, in the
// same spirit: watch how each login actually performs over real requests
// and adapt two concrete things automatically —
//
//   1. how long to wait before giving up on it (a login that's reliably
//      fast gets a tight timeout; one that's reliably slow gets more
//      patience, based on its own measured history — not a single global
//      guess for every login)
//   2. whether to bother calling it at all right now (a circuit breaker: an
//      login failing repeatedly — an expired password, a broken auth
//      header — gets skipped for a cooldown instead of eating a full
//      timeout on every single request until someone notices and fixes it)
//
// In-memory and per-process, same as every other cache in xcelerator.ts. It
// resets on restart and re-learns within a handful of requests — that's a
// deliberate simplicity trade-off, not an oversight.

type LoginStats = {
  /** Recent latencies (ms) from successful attempts only, oldest first, capped at HISTORY_SIZE. */
  latencies: number[];
  consecutiveFailures: number;
  /** Epoch ms after which this login may be tried again, once circuit-broken. */
  skipUntil: number;
};

const HISTORY_SIZE = 20;
const CIRCUIT_BREAK_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 45_000; // cold-start guess, used until a login has any recorded history
const MIN_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 90_000;
// Headroom over the observed average latency, so a normal call that's
// merely a bit slower than usual doesn't get cut off right at its own average.
const TIMEOUT_SAFETY_FACTOR = 1.6;

const stats = new Map<string, LoginStats>();

function statsFor(loginKey: string): LoginStats {
  let entry = stats.get(loginKey);
  if (!entry) {
    entry = { latencies: [], consecutiveFailures: 0, skipUntil: 0 };
    stats.set(loginKey, entry);
  }
  return entry;
}

/**
 * Records the outcome of one real attempt against a login (a login +
 * fetch, or an Axis call) so future attempts against that same login can
 * adapt. Call this from the actual network call site, not from a caller
 * that merely gave up waiting (see withTimeout in xcelerator.ts) — a
 * timeout means "we stopped waiting," not "the login failed."
 */
export function recordLoginAttempt(loginKey: string, latencyMs: number, success: boolean): void {
  const entry = statsFor(loginKey);
  if (success) {
    entry.latencies.push(latencyMs);
    if (entry.latencies.length > HISTORY_SIZE) entry.latencies.shift();
    entry.consecutiveFailures = 0;
    entry.skipUntil = 0;
  } else {
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
      entry.skipUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }
  }
}

/**
 * True when this login has failed CIRCUIT_BREAK_THRESHOLD times in a row
 * and is still within its cooldown — skip calling it rather than pay for
 * another timeout on a login that's very likely still broken. The next
 * attempt after the cooldown expires acts as the "half-open" probe: if it
 * succeeds, recordLoginAttempt resets the failure count; if it fails
 * again, the cooldown restarts.
 */
export function shouldSkipLogin(loginKey: string): boolean {
  const entry = stats.get(loginKey);
  if (!entry) return false;
  return entry.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD && Date.now() < entry.skipUntil;
}

/**
 * How long to wait for this login before giving up, based on its own
 * recent successful-call history. Falls back to a fixed default until
 * enough history exists to say anything meaningful.
 */
export function getAdaptiveTimeoutMs(loginKey: string): number {
  const entry = stats.get(loginKey);
  if (!entry || entry.latencies.length === 0) return DEFAULT_TIMEOUT_MS;

  const avg = entry.latencies.reduce((sum, v) => sum + v, 0) / entry.latencies.length;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(avg * TIMEOUT_SAFETY_FACTOR)));
}

export type LoginPerformanceSnapshot = Record<
  string,
  {
    avgLatencyMs: number | null;
    sampleCount: number;
    consecutiveFailures: number;
    circuitOpen: boolean;
    adaptiveTimeoutMs: number;
  }
>;

/** Read-only view of everything learned so far — backs GET /api/login-performance. */
export function loginPerformanceSnapshot(): LoginPerformanceSnapshot {
  const snapshot: LoginPerformanceSnapshot = {};
  for (const key of stats.keys()) {
    const entry = statsFor(key);
    snapshot[key] = {
      avgLatencyMs:
        entry.latencies.length > 0
          ? Math.round(entry.latencies.reduce((sum, v) => sum + v, 0) / entry.latencies.length)
          : null,
      sampleCount: entry.latencies.length,
      consecutiveFailures: entry.consecutiveFailures,
      circuitOpen: shouldSkipLogin(key),
      adaptiveTimeoutMs: getAdaptiveTimeoutMs(key),
    };
  }
  return snapshot;
}

/** Forgets everything learned so far (latencies, failure counts, open circuits). Used by the /debug page's reset button. */
export function resetLoginPerformance(): void {
  stats.clear();
}
