import type { NextRequest } from "next/server";

/**
 * Whether a request came from this app's own pages. Browsers send Origin on
 * POSTs and Sec-Fetch-Site on every fetch, so a form or script on another
 * site can't start an action here on a CSR's behalf. This is not
 * authentication: the app has no logins, and a non-browser client can set
 * these headers itself.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return site === "same-origin";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
