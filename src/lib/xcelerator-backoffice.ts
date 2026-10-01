// Read-only POD details from Xcelerator's back office: the Review Order
// screen (/Xcelerator/Orders/ReviewOrder/ReviewOrder?_p_Odata=<tracking id>)
// that dispatch uses. The ClientPortal callers cannot open it (their session
// is sent to the back-office login page), so this needs a back-office login:
// XCELERATOR_BACKOFFICE_USERNAME / XCELERATOR_BACKOFFICE_PASSWORD.
//
// The screen fills itself from two calls, and these are the only ones made
// here (plain HTTP with a cookie jar, no browser):
//  - POST /api/order/getReviewOrderData?_p_OrderTrackingId=<id>: the order,
//    including PODname ("POD Name") and PODcompletion ("POD D/T").
//  - POST /xApi/orderwebapi/getExtendedInfo: the "Advanced Options and
//    Activity" panel (change log, memos, scans), where the POD shows up as
//    "*[PODname] changed from [] to [29763672] by User:rdobbs", "... via
//    Wireless Device by DriverNo[755]", "AutoNotification email sent [On-POD]"
//    and memos like "POD is LATE".
// Reading does not lock the order: the screen only checks for someone else's
// edits when it saves (confirmed 2026-10-01: LockedBy/IsLocked unchanged
// after repeated reads). Without a session both calls answer HTTP 401.
//
// Server-only: reads credentials from the environment.

import { CookieJar, portalBaseUrlFromEnv } from "./xcelerator-portal";
import type { PodActivityEntry } from "./xcelerator";

type BackOfficeConfig = { baseUrl: string; username: string; password: string };

function backOfficeConfigFromEnv(): BackOfficeConfig | null {
  const username = process.env.XCELERATOR_BACKOFFICE_USERNAME?.trim();
  const password = process.env.XCELERATOR_BACKOFFICE_PASSWORD?.trim();
  if (!username || !password) return null;
  return { baseUrl: portalBaseUrlFromEnv(), username, password };
}

export function isBackOfficeConfigured(): boolean {
  return backOfficeConfigFromEnv() !== null;
}

const REQUEST_TIMEOUT_MS = 8_000;
/** A session unused this long is replaced rather than tried first. */
const SESSION_IDLE_MS = 15 * 60_000;
const MAX_ACTIVITY_ENTRIES = 25;

class BackOfficeSessionEnded extends Error {
  constructor() {
    super("the back-office session ended");
    this.name = "BackOfficeSessionEnded";
  }
}

type Session = { jar: CookieJar; lastUsed: number };

/** One back-office session per server instance, shared by every lookup. */
let current: Session | null = null;
let loggingIn: Promise<Session> | null = null;

async function send(cfg: BackOfficeConfig, jar: CookieJar, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.capture(res.headers);
  return res;
}

async function login(cfg: BackOfficeConfig): Promise<Session> {
  const jar = new CookieJar();
  const page = await send(cfg, jar, "/account/Account/Login", { headers: { Accept: "text/html" } });
  const html = await page.text();
  const token = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
  if (!page.ok || !token) throw new Error(`the back-office login page did not load (HTTP ${page.status})`);

  const res = await send(cfg, jar, "/account", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({
      __RequestVerificationToken: token,
      UserName: cfg.username,
      Password: cfg.password,
      HW: "720:1280",
    }),
  });
  // Success redirects into the app (/account/Account/LaunchXceleratorJS);
  // a refused login renders the form again.
  const location = res.headers.get("location") ?? "";
  if (res.status < 300 || res.status >= 400 || /\/Login\b/i.test(location)) {
    throw new Error(
      `the back-office login was refused for ${cfg.username}; check XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD`,
    );
  }
  return { jar, lastUsed: Date.now() };
}

async function session(cfg: BackOfficeConfig, fresh: boolean): Promise<Session> {
  if (!fresh && current && Date.now() - current.lastUsed < SESSION_IDLE_MS) return current;
  loggingIn ??= login(cfg)
    .then((s) => (current = s))
    .finally(() => (loggingIn = null));
  return loggingIn;
}

/**
 * Starts the back-office login in the background, so it overlaps the order
 * search instead of adding to it. Errors surface on the real read.
 */
export function warmBackOfficeSession(): void {
  const cfg = backOfficeConfigFromEnv();
  if (!cfg) return;
  session(cfg, false).catch(() => {});
}

async function postJson<T>(cfg: BackOfficeConfig, s: Session, path: string, body: string, contentType: string): Promise<T> {
  const res = await send(cfg, s.jar, path, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    body,
  });
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new BackOfficeSessionEnded();
  const text = await res.text();
  if (!res.ok) throw new Error(`the back office answered HTTP ${res.status} for ${path.split("?")[0]}`);
  try {
    s.lastUsed = Date.now();
    return JSON.parse(text) as T;
  } catch {
    if (/<form[^>]*\/account/i.test(text)) throw new BackOfficeSessionEnded();
    throw new Error(`the back office did not return data for ${path.split("?")[0]}`);
  }
}

type ReviewOrderData = {
  PODname?: string | null;
  PODcompletion?: string | null;
};

type ExtendedInfoEntry = {
  Type?: string | null;
  TimeStamp?: string | null;
  FieldName?: string | null;
  Details?: string | null;
  Memo?: string | null;
};

export type BackOfficePod = {
  /** "POD Name" on the Review Order screen. */
  podName: string | null;
  /** "POD D/T", the portal's wall-clock time as a zone-less ISO string. */
  podAt: string | null;
  /** Activity entries that mention the POD, newest first. */
  activity: PodActivityEntry[];
};

const KIND_LABELS: Record<string, string> = {
  changeLog: "Change log",
  memoLog: "Memo",
  scanLog: "Scan",
  scheduleChangeLog: "Schedule change",
};

/**
 * Whether an activity entry is about the POD: a POD field changed (PODname,
 * PODcompletion, PODnameRT, POD_RTcompletion), a POD email or memo, or a
 * delivery-note / signature document uploaded.
 */
function mentionsPod(fieldName: string, text: string): boolean {
  return (
    /\bPOD/i.test(fieldName) ||
    /\bPOD/i.test(text) ||
    /Document Name\[[^\]]*(pod|deliver|signature|signed|proof|receipt)/i.test(text)
  );
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Activity timestamps are UTC (a driver's wireless POD at 08:26 local is
 * logged at 12:26 in October, 22:21 for an 18:21 pickup in March), while
 * every other time on an order is the portal's wall clock. Converted to
 * Eastern wall-clock time so they line up with POD D/T and the arrivals.
 */
function easternWallClock(utc: string | null | undefined): string | null {
  if (!utc?.trim()) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(utc) ? utc : `${utc}Z`);
  if (Number.isNaN(date.getTime())) return null;
  const p = Object.fromEntries(EASTERN.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function podActivity(entries: ExtendedInfoEntry[]): PodActivityEntry[] {
  const out: PodActivityEntry[] = [];
  for (const e of entries) {
    const text = (e.Details || e.Memo || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text || !mentionsPod(e.FieldName ?? "", text)) continue;
    out.push({
      at: easternWallClock(e.TimeStamp),
      kind: KIND_LABELS[e.Type ?? ""] ?? e.Type ?? "Activity",
      text: text.replace(/^\*/, ""),
    });
  }
  return out
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, MAX_ACTIVITY_ENTRIES);
}

/**
 * The POD name, POD date/time and POD activity for one order, by its
 * Xcelerator tracking id (e.g. "105.031826"). Logs in when there is no
 * session, and once more if the session turns out to have ended.
 */
export async function readBackOfficePod(orderTrackingId: string): Promise<BackOfficePod> {
  const cfg = backOfficeConfigFromEnv();
  if (!cfg) throw new Error("the back office is not configured (XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD)");
  const id = encodeURIComponent(orderTrackingId.trim());
  // Only the logs the POD can appear in; no cases, proposals or card log.
  const activityQuery = new URLSearchParams({
    OrderTrackingId: orderTrackingId.trim(),
    ShowCases: "false",
    ShowReasonCodes: "false",
    ShowMemoLog: "true",
    ShowChangeLog: "true",
    ShowScheduleHistory: "false",
    ShowScanLog: "true",
    ShowProposals: "false",
    ShowCCLog: "false",
    ViewChargeAmount: "false",
    ViewDriverAmount: "false",
    DeleteOrderMemos: "false",
    TimeZoneId: "14",
  }).toString();

  const read = async (fresh: boolean): Promise<BackOfficePod> => {
    const s = await session(cfg, fresh);
    const [order, activity] = await Promise.all([
      postJson<ReviewOrderData | null>(
        cfg,
        s,
        `/api/order/getReviewOrderData?_p_OrderTrackingId=${id}`,
        '""',
        "application/json; charset=utf-8",
      ),
      postJson<ExtendedInfoEntry[] | null>(
        cfg,
        s,
        "/xApi/orderwebapi/getExtendedInfo",
        activityQuery,
        "application/x-www-form-urlencoded; charset=UTF-8",
      ),
    ]);
    if (!order) throw new Error(`the back office has no order ${orderTrackingId}`);
    return {
      podName: order.PODname?.trim() || null,
      podAt: order.PODcompletion?.trim() || null,
      activity: podActivity(Array.isArray(activity) ? activity : []),
    };
  };

  try {
    return await read(false);
  } catch (err) {
    if (!(err instanceof BackOfficeSessionEnded)) throw err;
    current = null;
    return read(true);
  }
}
