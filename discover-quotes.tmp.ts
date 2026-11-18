// Temporary, read-only discovery (deleted after the run): where do Xcelerator's
// ClientPortal and back office handle quotes? Only GETs plus the normal logins.
import { CookieJar, loginToPortal, portalBaseUrlFromEnv, xceleratorCallersFromEnv } from "./src/lib/xcelerator-portal";

const QUOTE = /quot/i;

function scriptsIn(html: string): string[] {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
}

function quoteLines(text: string, max = 40): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[^\n;{}]{0,120}quot[^\n;{}]{0,160}/gi)) {
    const line = m[0].replace(/\s+/g, " ").trim();
    if (/quot(e|ation|ing|es)\b|quote[A-Z_]|Quote/i.test(line) && !/&quot;|\\"|quotes?\s*\(\s*\)|replace\(/.test(line)) out.add(line.slice(0, 260));
    if (out.size >= max) break;
  }
  return [...out];
}

function apiPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/["'`]([^"'`\s]*(?:api|Api|xApi)[^"'`\s]*quot[^"'`\s]*)["'`]/gi)].map((m) => m[1]))];
}

async function fetchText(url: string, jar: CookieJar): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(url, { headers: { Cookie: jar.header() ?? "", Accept: "*/*" }, redirect: "manual" });
  jar.capture(res.headers);
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function scan(label: string, base: string, pages: string[], jar: CookieJar) {
  console.log(`\n######## ${label}`);
  const scripts = new Set<string>();
  for (const page of pages) {
    const { status, text, location } = await fetchText(`${base}${page}`, jar);
    console.log(`\n== page ${page}: HTTP ${status}${location ? ` -> ${location}` : ""}, ${text.length} chars`);
    for (const line of quoteLines(text, 25)) console.log(`   ${line}`);
    for (const src of scriptsIn(text)) scripts.add(new URL(src, `${base}${page}`).toString());
  }
  for (const src of scripts) {
    if (!src.startsWith(new URL(base).origin)) continue;
    const { status, text } = await fetchText(src, jar);
    const lines = quoteLines(text, 30);
    const paths = apiPaths(text);
    if (!lines.length && !paths.length) continue;
    console.log(`\n== script ${src.replace(new URL(base).origin, "")} (HTTP ${status}, ${text.length} chars)`);
    for (const p of paths) console.log(`   API: ${p}`);
    for (const line of lines) console.log(`   ${line}`);
  }
}

(async () => {
  const base = portalBaseUrlFromEnv();
  const caller = xceleratorCallersFromEnv()[0];
  console.log("portal base:", base, "| caller:", caller?.name ?? caller?.cfg?.username);
  const session = await loginToPortal(caller.cfg);
  await scan("ClientPortal", base, ["/ClientPortal/ClientPortal/Main"], session.jar);

  const user = process.env.XCELERATOR_BACKOFFICE_USERNAME?.trim();
  const pass = process.env.XCELERATOR_BACKOFFICE_PASSWORD?.trim();
  if (!user || !pass) return console.log("\n(no back-office login set)");
  const jar = new CookieJar();
  const loginPage = await fetchText(`${base}/account/Account/Login`, jar);
  const token = loginPage.text.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1] ?? "";
  const res = await fetch(`${base}/account`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() ?? "" },
    body: new URLSearchParams({ __RequestVerificationToken: token, UserName: user, Password: pass, HW: "720:1280" }),
  });
  jar.capture(res.headers);
  console.log("\nback-office login:", res.status, res.headers.get("location"));
  await scan("Back office", base, ["/account/Account/LaunchXceleratorJS"], jar);
})().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
