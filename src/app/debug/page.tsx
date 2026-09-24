"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { DebugStatus } from "@/lib/debug-status";

// ---------------------------------------------------------------------------
// Small helpers

type Tone = "emerald" | "amber" | "red" | "zinc" | "indigo";

const TONE_CLASSES: Record<Tone, string> = {
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300",
  zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300",
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

function Card({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-sm dark:border-zinc-800/70 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400";
const GHOST_BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function httpTone(status: number | null): Tone {
  if (status === null) return "red";
  if (status >= 200 && status < 300) return "emerald";
  if (status === 404) return "amber";
  return "red";
}

// ---------------------------------------------------------------------------
// Calling the API and timing it

type CallResult = {
  httpStatus: number | null;
  ms: number;
  body: unknown;
  networkError?: string;
};

async function timedRequest(url: string, init?: RequestInit): Promise<CallResult> {
  const startedAt = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: keep the raw text
    }
    return { httpStatus: res.status, ms: Math.round(performance.now() - startedAt), body };
  } catch (err) {
    return {
      httpStatus: null,
      ms: Math.round(performance.now() - startedAt),
      body: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

function ResultView({ result, summary }: { result: CallResult; summary?: ReactNode }) {
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={httpTone(result.httpStatus)}>
          {result.httpStatus === null ? "No response" : `HTTP ${result.httpStatus}`}
        </Badge>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">took {fmtMs(result.ms)}</span>
      </div>
      {result.networkError && (
        <p className="text-xs text-red-600 dark:text-red-400">{result.networkError}</p>
      )}
      {summary}
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-500 hover:text-indigo-600 dark:text-zinc-400">
          Raw response
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-300">
      {children}
    </p>
  );
}

function Tester({
  title,
  hint,
  placeholder,
  buttonLabel,
  buildUrl,
  summarize,
  onDone,
}: {
  title: string;
  hint: string;
  placeholder: string;
  buttonLabel: string;
  buildUrl: (value: string) => string;
  summarize: (body: unknown) => ReactNode;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState<CallResult | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || running) return;

    setRunning(true);
    setResult(null);
    setElapsedSec(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSec(Math.round((Date.now() - startedAt) / 1000)), 1000);

    const r = await timedRequest(buildUrl(trimmed));

    clearInterval(timer);
    setResult(r);
    setRunning(false);
    onDone();
  }

  return (
    <Card title={title} hint={hint}>
      <form onSubmit={run} className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={running || !value.trim()} className={BUTTON_CLASS}>
          {running ? `Running… ${elapsedSec}s` : buttonLabel}
        </button>
      </form>
      {result && <ResultView result={result} summary={summarize(result.body)} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summaries for each tester

function summarizeLookup(body: unknown): ReactNode {
  const b = asRecord(body);
  if (!b) return null;
  const order = asRecord(b.order);
  return (
    <>
      {order && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">
          Found <strong>{String(order.referenceNumber)}</strong> ({String(order.customer)}), status{" "}
          <strong>{String(order.status)}</strong>, via <strong>{String(b.source)}</strong>.
        </p>
      )}
      {typeof b.error === "string" && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">{b.error}</p>
      )}
      {typeof b.warning === "string" && <Warn>{b.warning}</Warn>}
    </>
  );
}

function summarizeCallerSearch(body: unknown): ReactNode {
  const b = asRecord(body);
  if (!b) return null;
  const matches = Array.isArray(b.matches) ? b.matches : null;
  return (
    <>
      {matches && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">
          {matches.length} match{matches.length === 1 ? "" : "es"} via <strong>{String(b.source)}</strong>.
        </p>
      )}
      {typeof b.error === "string" && (
        <p className="text-xs text-red-600 dark:text-red-400">{b.error}</p>
      )}
      {typeof b.warning === "string" && <Warn>{b.warning}</Warn>}
    </>
  );
}

function summarizeAxisProbe(body: unknown): ReactNode {
  const b = asRecord(body);
  if (!b) return null;
  const auth = asRecord(b.auth);
  const snippet = typeof b.body === "string" ? b.body : null;
  return (
    <>
      <p className="text-xs text-zinc-700 dark:text-zinc-300">
        Sent with <strong>{auth ? String(auth.mode) : "unknown"}</strong> auth
        {auth?.scheme ? ` (${String(auth.scheme)})` : ""}. Axis answered{" "}
        <strong>{b.status === null ? "nothing" : `HTTP ${String(b.status)}`}</strong>.
      </p>
      {typeof b.error === "string" && <Warn>{b.error}</Warn>}
      {snippet !== null && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {snippet}
          {b.bodyTruncated ? "\n…(truncated)" : ""}
        </pre>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Callers table

type LoginTest = { state: "running" } | { state: "done"; ok: boolean; ms: number; error?: string };

function CallerRow({
  label,
  username,
  perf,
  onDone,
}: {
  label: string;
  username: string;
  perf: DebugStatus["performance"][string] | undefined;
  onDone: () => void;
}) {
  const [test, setTest] = useState<LoginTest | null>(null);

  async function runTest() {
    setTest({ state: "running" });
    const r = await timedRequest(`/api/debug/login-test?caller=${encodeURIComponent(label)}`);
    const b = asRecord(r.body);
    setTest({
      state: "done",
      ok: b?.ok === true,
      ms: typeof b?.ms === "number" ? b.ms : r.ms,
      error: typeof b?.error === "string" ? b.error : r.networkError,
    });
    onDone();
  }

  return (
    <tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
      <td className="py-2 pr-3">
        <div className="font-medium text-zinc-900 dark:text-zinc-100">{label}</div>
        {label !== username && <div className="text-xs text-zinc-500 dark:text-zinc-400">{username}</div>}
      </td>
      <td className="py-2 pr-3">
        {!perf ? (
          <span className="text-xs text-zinc-400">no attempts yet</span>
        ) : perf.circuitOpen ? (
          <Badge tone="red">skipped (circuit open)</Badge>
        ) : perf.consecutiveFailures > 0 ? (
          <Badge tone="amber">{perf.consecutiveFailures} failed in a row</Badge>
        ) : (
          <Badge tone="emerald">healthy</Badge>
        )}
      </td>
      <td className="py-2 pr-3 text-xs text-zinc-700 dark:text-zinc-300">
        {perf?.avgLatencyMs != null ? fmtMs(perf.avgLatencyMs) : "-"}
        {perf && <span className="text-zinc-400"> over {perf.sampleCount}</span>}
      </td>
      <td className="py-2 pr-3 text-xs text-zinc-700 dark:text-zinc-300">
        {perf ? fmtMs(perf.adaptiveTimeoutMs) : "-"}
      </td>
      <td className="py-2">
        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            onClick={runTest}
            disabled={test?.state === "running"}
            className={GHOST_BUTTON_CLASS}
          >
            {test?.state === "running" ? "Logging in…" : "Test login"}
          </button>
          {test?.state === "done" && (
            <span
              className={`text-xs ${test.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
            >
              {test.ok ? `logged in in ${fmtMs(test.ms)}` : `failed after ${fmtMs(test.ms)}: ${test.error ?? "unknown error"}`}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Page

async function fetchStatus(): Promise<DebugStatus> {
  const res = await fetch("/api/debug/status", { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Status request failed (${res.status})`);
  return body as DebugStatus;
}

export default function DebugPage() {
  const [status, setStatus] = useState<DebugStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((err) => setStatusError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [auto, refresh]);

  async function runAction(action: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyAction(action);
    await timedRequest("/api/debug/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusyAction(null);
    refresh();
  }

  const perfKeys = status ? Object.keys(status.performance) : [];
  const cacheEntries = status ? status.caches.portalRows.length + status.caches.axisAllOrders.length : 0;

  return (
    <div className="flex flex-1 flex-col bg-gradient-to-b from-zinc-50 to-white font-sans dark:from-zinc-950 dark:to-zinc-900">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Debug</h1>
            <p className="mt-0.5 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
              What is configured, how each caller is performing, and tools to test lookups. Nothing on this
              page shows a password, token, or API key.
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-3 text-xs font-medium">
            <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              Auto-refresh (5s)
            </label>
            <button type="button" onClick={refresh} className={GHOST_BUTTON_CLASS}>
              Refresh
            </button>
            <Link href="/test" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Raw order list
            </Link>
            <Link href="/" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Back to lookup
            </Link>
          </nav>
        </header>

        {statusError && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300">
            {statusError}
          </p>
        )}

        {!status && !statusError && <p className="text-sm text-zinc-500">Loading…</p>}

        {status && (
          <>
            {status.notes.length > 0 && (
              <Card title="Worth a look" hint="Derived from the current configuration and what has been observed.">
                <ul className="space-y-2">
                  {status.notes.map((note) => (
                    <li key={note}>
                      <Warn>{note}</Warn>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              <Card title="Integrations" hint={`Environment: ${status.nodeEnv}`}>
                <dl className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">Data source</dt>
                    <dd>
                      {status.mockMode ? <Badge tone="amber">Sample data</Badge> : <Badge tone="emerald">Live Xcelerator</Badge>}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">Xcelerator callers</dt>
                    <dd className="text-zinc-900 dark:text-zinc-100">
                      {status.callers.list.length}
                      {status.callers.source === "legacy" && <span className="text-zinc-400"> (older variables)</span>}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">Axis API</dt>
                    <dd className="flex items-center gap-2">
                      {status.axis.auth.mode === "token" ? (
                        <Badge tone="emerald">token{status.axis.auth.scheme ? ` (${status.axis.auth.scheme})` : ""}</Badge>
                      ) : status.axis.auth.mode === "basic" ? (
                        <Badge tone="amber">username/password (Basic)</Badge>
                      ) : (
                        <Badge tone="zinc">not configured</Badge>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">Missive</dt>
                    <dd>{status.missiveConfigured ? <Badge tone="emerald">token set</Badge> : <Badge tone="zinc">not configured</Badge>}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">OpenAI replies</dt>
                    <dd className="flex items-center gap-2">
                      {status.openai.configured ? <Badge tone="emerald">key set</Badge> : <Badge tone="zinc">template only</Badge>}
                      <span className="text-xs text-zinc-500">{status.openai.model}</span>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-600 dark:text-zinc-400">AccountNo filter</dt>
                    <dd className="text-xs text-zinc-900 dark:text-zinc-100">
                      {status.accountScoping ? status.accountScoping.join(", ") : <span className="text-zinc-400">none (all accounts)</span>}
                    </dd>
                  </div>
                </dl>
              </Card>

              <Card
                title="Lookup caches"
                hint={`Order lists are kept ${status.caches.ttlSeconds}s so repeat searches don't log in again.`}
                actions={
                  <button
                    type="button"
                    disabled={busyAction === "clear-caches" || cacheEntries === 0}
                    onClick={() => runAction("clear-caches")}
                    className={GHOST_BUTTON_CLASS}
                  >
                    Clear caches
                  </button>
                }
              >
                {cacheEntries === 0 && status.caches.portalRowsInFlight + status.caches.axisAllOrdersInFlight === 0 ? (
                  <p className="text-xs text-zinc-500">Empty. The next search will fetch fresh.</p>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {[...status.caches.portalRows.map((e) => ({ ...e, kind: "portal" })), ...status.caches.axisAllOrders.map((e) => ({ ...e, kind: "axis" }))].map((e) => (
                      <li key={`${e.kind}-${e.key}`} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="break-all text-zinc-700 dark:text-zinc-300">
                          {e.kind}: {e.key}
                        </span>
                        <span className="text-zinc-500">
                          {e.count} orders, {e.expiresInSec > 0 ? `expires in ${e.expiresInSec}s` : "expired"}
                        </span>
                      </li>
                    ))}
                    {status.caches.portalRowsInFlight + status.caches.axisAllOrdersInFlight > 0 && (
                      <li className="text-zinc-500">
                        {status.caches.portalRowsInFlight + status.caches.axisAllOrdersInFlight} fetch(es) still running
                      </li>
                    )}
                  </ul>
                )}
              </Card>
            </div>

            <Card
              title="Callers"
              hint="Every caller is checked the same way. Latency and failures are learned from real requests since the server started."
              actions={
                <button
                  type="button"
                  disabled={busyAction === "reset-performance" || perfKeys.length === 0}
                  onClick={() =>
                    runAction("reset-performance", "Forget everything learned about callers, including any that are currently being skipped?")
                  }
                  className={GHOST_BUTTON_CLASS}
                >
                  Reset learned stats
                </button>
              }
            >
              {status.callers.list.length === 0 ? (
                <p className="text-xs text-zinc-500">No callers configured.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                    <thead className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
                      <tr>
                        <th className="pb-2 pr-3 font-medium">Caller</th>
                        <th className="pb-2 pr-3 font-medium">State</th>
                        <th className="pb-2 pr-3 font-medium">Avg login+fetch</th>
                        <th className="pb-2 pr-3 font-medium">Waits up to</th>
                        <th className="pb-2 font-medium">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.callers.list.map((c) => (
                        <CallerRow
                          key={c.label}
                          label={c.label}
                          username={c.username}
                          perf={status.performance[c.username]}
                          onDone={refresh}
                        />
                      ))}
                      {status.performance.axis && (
                        <tr className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">Axis API</td>
                          <td className="py-2 pr-3">
                            {status.performance.axis.circuitOpen ? (
                              <Badge tone="red">skipped (circuit open)</Badge>
                            ) : status.performance.axis.consecutiveFailures > 0 ? (
                              <Badge tone="amber">{status.performance.axis.consecutiveFailures} failed in a row</Badge>
                            ) : (
                              <Badge tone="emerald">healthy</Badge>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {status.performance.axis.avgLatencyMs != null ? fmtMs(status.performance.axis.avgLatencyMs) : "-"}
                          </td>
                          <td className="py-2 pr-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {fmtMs(status.performance.axis.adaptiveTimeoutMs)}
                          </td>
                          <td className="py-2 text-xs text-zinc-500">use the Axis probe below</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Tester
            title="Order lookup"
            hint="Runs the same lookup as the main page against every caller, and shows the raw result."
            placeholder="Reference or tracking ID"
            buttonLabel="Look up"
            buildUrl={(v) => `/api/orders/${encodeURIComponent(v)}`}
            summarize={summarizeLookup}
            onDone={refresh}
          />
          <Tester
            title="Caller search"
            hint="Finds orders by the caller's name, department, phone, or email."
            placeholder="Name, phone, or email"
            buttonLabel="Search"
            buildUrl={(v) => `/api/callers/search?q=${encodeURIComponent(v)}`}
            summarize={summarizeCallerSearch}
            onDone={refresh}
          />
        </div>

        <Tester
          title="Axis probe"
          hint="One raw Axis GetOrderByReference call, no mapping and no fallback. Tells a 401 (credential) from a 200 with nothing found from no response at all."
          placeholder="Reference number"
          buttonLabel="Probe Axis"
          buildUrl={(v) => `/api/debug/axis-probe?ref=${encodeURIComponent(v)}`}
          summarize={summarizeAxisProbe}
          onDone={refresh}
        />

        {status && (
          <Card
            title="Recent activity"
            hint="The last lookups, searches, and probes this server handled, newest first."
            actions={
              <button
                type="button"
                disabled={busyAction === "clear-events" || status.events.length === 0}
                onClick={() => runAction("clear-events")}
                className={GHOST_BUTTON_CLASS}
              >
                Clear
              </button>
            }
          >
            {status.events.length === 0 ? (
              <p className="text-xs text-zinc-500">Nothing yet. Run a lookup and it will show up here.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                  <thead className="uppercase text-zinc-500 dark:text-zinc-400">
                    <tr>
                      <th className="pb-2 pr-3 font-medium">Time</th>
                      <th className="pb-2 pr-3 font-medium">Kind</th>
                      <th className="pb-2 pr-3 font-medium">Query</th>
                      <th className="pb-2 pr-3 font-medium">Result</th>
                      <th className="pb-2 pr-3 font-medium">Took</th>
                      <th className="pb-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.events.map((ev) => (
                      <tr key={ev.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                        <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-500">{fmtTime(ev.at)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">{ev.kind}</td>
                        <td className="max-w-[10rem] truncate py-1.5 pr-3 text-zinc-900 dark:text-zinc-100" title={ev.query}>
                          {ev.query}
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          <Badge tone={ev.ok ? "emerald" : "amber"}>{ev.outcome}</Badge>
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">{fmtMs(ev.ms)}</td>
                        <td className="max-w-xs py-1.5 text-zinc-500" title={ev.detail}>
                          <span className="line-clamp-2">{ev.detail ?? ""}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
