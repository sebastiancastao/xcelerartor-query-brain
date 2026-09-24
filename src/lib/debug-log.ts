// Backing store for the /debug page: a small in-memory ring of recent
// lookups, searches and probes so "why was that slow / why did that fail"
// can be answered after the fact. Per server process, lost on restart, and
// stored on globalThis so dev-mode module reloads don't fork it into
// several separate logs.

export type DebugEventKind = "lookup" | "caller-search" | "axis-probe" | "login-test";

export type DebugEvent = {
  id: number;
  /** ISO timestamp. */
  at: string;
  kind: DebugEventKind;
  /** What was asked: the reference number, search term, or caller tested. */
  query: string;
  ms: number;
  /** Short result, e.g. "found via portal", "not found", "3 matches", "HTTP 401". */
  outcome: string;
  ok: boolean;
  /** The warning or error text, when there was one. */
  detail?: string;
};

const MAX_EVENTS = 100;

type DebugGlobal = { __debugEvents?: DebugEvent[]; __debugEventSeq?: number };
const store = globalThis as unknown as DebugGlobal;

/**
 * The debug page and its endpoints are available in development, and off in
 * production unless ENABLE_DEBUG_PAGE=true: this app has no login, and the
 * page shows which callers are configured and how they're performing.
 * Passwords and tokens are never included either way.
 */
export function isDebugEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEBUG_PAGE === "true";
}

export function logDebugEvent(event: Omit<DebugEvent, "id" | "at">): void {
  const events = (store.__debugEvents ??= []);
  store.__debugEventSeq = (store.__debugEventSeq ?? 0) + 1;
  events.unshift({ ...event, id: store.__debugEventSeq, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function recentDebugEvents(): DebugEvent[] {
  return [...(store.__debugEvents ?? [])];
}

export function clearDebugEvents(): void {
  store.__debugEvents = [];
}
