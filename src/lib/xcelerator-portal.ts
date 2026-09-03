// Session client for Skyline Courier & Logistics' Xcelerator ClientPortal.
//
// There is no API key / bearer token for this deployment — the caller
// credentials are portal credentials: username/password -> ASP.NET session
// cookie -> internal ClientPortal AJAX endpoints under
// /ClientPortal/ClientPortal/api/*. This mirrors the login flow reverse
// engineered in the skyline-xcelarator-master reference project's
// src/lib/axis.ts (which uses this same portal to submit new orders).
//
// Server-only: reads credentials from the environment and must never run in
// the browser.

export type XceleratorPortalConfig = {
  /** Base Xcelerator URL, no trailing slash. */
  portalBaseUrl: string;
  username?: string;
  password?: string;
  credentialLabel?: string;
};

const DEFAULT_PORTAL_BASE_URL = "https://skylinecourierlogistics.com/Xcelerator";

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function xceleratorConfigFromEnv(): XceleratorPortalConfig {
  const lookupUsername = envValue("XCELERATOR_LOOKUP_USERNAME");
  const lookupPassword = envValue("XCELERATOR_LOOKUP_PASSWORD");
  const hasLookupCredentials = Boolean(lookupUsername && lookupPassword);
  const credentialLabel = hasLookupCredentials
    ? "XCELERATOR_LOOKUP_USERNAME and XCELERATOR_LOOKUP_PASSWORD"
    : "XCELERATOR_USERNAME and XCELERATOR_PASSWORD";

  return {
    portalBaseUrl: (envValue("XCELERATOR_PORTAL_BASE_URL") || DEFAULT_PORTAL_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    username: hasLookupCredentials ? lookupUsername : envValue("XCELERATOR_USERNAME"),
    password: hasLookupCredentials ? lookupPassword : envValue("XCELERATOR_PASSWORD"),
    credentialLabel,
  };
}

export class XceleratorPortalError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "XceleratorPortalError";
    this.status = status;
  }
}

// --- Cookie jar --------------------------------------------------------------

class CookieJar {
  private values = new Map<string, string>();

  header(): string {
    return [...this.values.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  capture(headers: Headers) {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const rawCookies =
      typeof withGetSetCookie.getSetCookie === "function"
        ? withGetSetCookie.getSetCookie()
        : splitSetCookieHeader(headers.get("set-cookie"));

    for (const raw of rawCookies) {
      const first = raw.split(";", 1)[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      if (/;\s*(max-age=0|expires=thu,\s*01 jan 1970)/i.test(raw)) {
        this.values.delete(name);
      } else {
        this.values.set(name, value);
      }
    }
  }
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((v) => v.trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}=(["'])(.*?)\\1`, "i"));
  return m ? decodeHtml(m[2]) : undefined;
}

function parseFormInputs(html: string, formId: string): Record<string, string> {
  const form =
    html.match(new RegExp(`<form[^>]*id=(["'])${formId}\\1[\\s\\S]*?</form>`, "i"))?.[0] ?? html;
  const values: Record<string, string> = {};
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(m[0], "name");
    if (name) values[name] = attr(m[0], "value") ?? "";
  }
  return values;
}

function portalPathFromLocation(cfg: XceleratorPortalConfig, location: string): string {
  const url = new URL(location, `${cfg.portalBaseUrl}/ClientPortal`);
  const basePath = new URL(cfg.portalBaseUrl).pathname.replace(/\/+$/, "");
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || "/"
    : url.pathname;
  return `${path}${url.search}`;
}

// --- Session -------------------------------------------------------------

export type PortalSession = {
  cfg: XceleratorPortalConfig;
  jar: CookieJar;
};

async function portalFetch(
  session: PortalSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = session.jar.header();
  if (cookie) headers.set("Cookie", cookie);

  const res = await fetch(`${session.cfg.portalBaseUrl}${path}`, {
    ...init,
    headers,
  });
  session.jar.capture(res.headers);
  return res;
}

/** GET (or arbitrary) a ClientPortal path and parse the JSON response. */
export async function portalJson<T>(
  session: PortalSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await portalFetch(session, path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new XceleratorPortalError(
      `ClientPortal ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new XceleratorPortalError(`ClientPortal ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** POST a JSON body to a ClientPortal path and parse the JSON response. */
export async function postPortalJson<T>(
  session: PortalSession,
  path: string,
  data: unknown,
): Promise<T> {
  return portalJson<T>(session, path, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  });
}

/**
 * Log in to the Xcelerator ClientPortal with username/password and return a
 * session (cookie jar) that portalJson/postPortalJson can reuse for
 * subsequent calls. Each call to this function performs a fresh login — the
 * caller is responsible for holding on to the returned session if it wants
 * to make several calls without logging in again.
 */
export async function loginToPortal(
  cfg: XceleratorPortalConfig = xceleratorConfigFromEnv(),
): Promise<PortalSession> {
  const credentialLabel = cfg.credentialLabel ?? "XCELERATOR_USERNAME and XCELERATOR_PASSWORD";

  if (!cfg.username || !cfg.password) {
    throw new XceleratorPortalError(
      `Xcelerator portal is not configured. Set ${credentialLabel}.`,
    );
  }

  const session: PortalSession = { cfg, jar: new CookieJar() };
  const loginPath = "/ClientPortal";

  const loginPage = await portalFetch(session, loginPath, {
    headers: { Accept: "text/html" },
  });
  const loginHtml = await loginPage.text();
  if (!loginPage.ok) {
    throw new XceleratorPortalError(
      `Xcelerator portal login page failed (HTTP ${loginPage.status}).`,
      loginPage.status,
    );
  }

  const form = parseFormInputs(loginHtml, "loginForm");
  form["loginModel.UserName"] = cfg.username;
  form["loginModel.Password"] = cfg.password;

  const res = await portalFetch(session, loginPath, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${cfg.portalBaseUrl}${loginPath}`,
    },
    body: new URLSearchParams(form),
  });

  let text = "";
  let status = res.status;
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const nextPath = portalPathFromLocation(cfg, res.headers.get("location")!);
    const finalRes = await portalFetch(session, nextPath, {
      headers: {
        Accept: "text/html",
        Referer: `${cfg.portalBaseUrl}${loginPath}`,
      },
    });
    status = finalRes.status;
    text = await finalRes.text();
  } else {
    text = await res.text();
  }

  if (status < 200 || status >= 300) {
    throw new XceleratorPortalError(`Xcelerator portal login failed (HTTP ${status}).`, status);
  }

  if (!session.jar.has("Xcelerator.ClientPortal") && /id=["']loginForm["']/i.test(text)) {
    throw new XceleratorPortalError(
      `Xcelerator portal login failed for ${cfg.username}; check ${credentialLabel}.`,
    );
  }

  return session;
}
