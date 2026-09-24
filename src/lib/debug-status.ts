import { describeAxisAuth, isAxisApiConfigured, type AxisAuthDescription } from "./axis-api";
import { recentDebugEvents, type DebugEvent } from "./debug-log";
import { loginPerformanceSnapshot, type LoginPerformanceSnapshot } from "./login-performance";
import { isMissiveConfigured } from "./missive";
import { isOpenAIConfigured } from "./openai";
import { xceleratorCallersFromEnv } from "./xcelerator-portal";
import { debugCacheStats } from "./xcelerator";

export type DebugStatus = {
  generatedAt: string;
  nodeEnv: string;
  /** True when no callers are configured, so lookups are answering from built-in sample data. */
  mockMode: boolean;
  callers: {
    /** Where the callers came from: the numbered XCELERATOR_CALLER_N_* list, or the older single-user variables. */
    source: "numbered" | "legacy" | "none";
    list: { label: string; username: string }[];
  };
  axis: { configured: boolean; auth: AxisAuthDescription };
  missiveConfigured: boolean;
  openai: { configured: boolean; model: string };
  /** AXIS_ACCOUNT_NO parsed into its codes, or null when not set (no filtering). */
  accountScoping: string[] | null;
  /** Plain-language things worth a look, derived from the state above. */
  notes: string[];
  performance: LoginPerformanceSnapshot;
  caches: ReturnType<typeof debugCacheStats>;
  events: DebugEvent[];
};

function parseAccountScoping(): string[] | null {
  const raw = process.env.AXIS_ACCOUNT_NO?.trim();
  if (!raw) return null;
  const codes = raw
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  return codes.length > 0 ? codes : null;
}

/**
 * Everything the /debug page shows about configuration and runtime state.
 * Reports whether a credential is set and how it's used, never its value:
 * no passwords, no tokens, no API keys.
 */
export function collectDebugStatus(): DebugStatus {
  const callers = xceleratorCallersFromEnv();
  const source: DebugStatus["callers"]["source"] =
    callers.length === 0
      ? "none"
      : callers[0].cfg.credentialLabel?.startsWith("XCELERATOR_CALLER_")
        ? "numbered"
        : "legacy";

  const axisAuth = describeAxisAuth();
  const accountScoping = parseAccountScoping();
  const performance = loginPerformanceSnapshot();

  const notes: string[] = [];
  if (callers.length === 0) {
    notes.push(
      "No Xcelerator callers are configured, so every lookup is answered from built-in sample data. Set XCELERATOR_CALLER_1_USERNAME and _PASSWORD in .env.local.",
    );
  }
  if (source === "legacy") {
    notes.push(
      "Callers are coming from the older single-user variables (XCELERATOR_USERNAME or XCELERATOR_LOOKUP_*). Move them to XCELERATOR_CALLER_1_* to add more than one.",
    );
  }
  if (axisAuth.mode === "basic") {
    notes.push(
      "Axis is being called with a username and password (Basic). Axis support said on 2026-09-23 that a token is required, and this deployment has answered 401 to Basic. Set AXIS_API_TOKEN to the token value.",
    );
  }
  if (axisAuth.mode === "none") {
    notes.push("Axis is not configured (no AXIS_API_TOKEN, and no AXIS_USERNAME + AXIS_PASSWORD).");
  }
  if (accountScoping) {
    notes.push(
      `AXIS_ACCOUNT_NO limits list-based searches (caller search, and the order-list fallback in lookups) to AccountNo ${accountScoping.join(", ")}, for every caller. Orders under any other AccountNo are dropped from those results.`,
    );
  }
  for (const [key, entry] of Object.entries(performance)) {
    if (entry.circuitOpen) {
      notes.push(`"${key}" has failed repeatedly and is being skipped for a cooldown. Use Reset learned stats to retry it immediately.`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV ?? "unknown",
    mockMode: callers.length === 0,
    callers: {
      source,
      list: callers.map((c) => ({ label: c.label, username: c.cfg.username ?? "" })),
    },
    axis: { configured: isAxisApiConfigured(), auth: axisAuth },
    missiveConfigured: isMissiveConfigured(),
    openai: {
      configured: isOpenAIConfigured(),
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini (default)",
    },
    accountScoping,
    notes,
    performance,
    caches: debugCacheStats(),
    events: recentDebugEvents(),
  };
}
