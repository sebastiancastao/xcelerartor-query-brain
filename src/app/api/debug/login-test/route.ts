import { NextResponse } from "next/server";
import { isDebugEnabled, logDebugEvent } from "@/lib/debug-log";
import { recordLoginAttempt } from "@/lib/login-performance";
import { loginToPortal, xceleratorCallersFromEnv } from "@/lib/xcelerator-portal";

// GET /api/debug/login-test?caller=<label or username> — performs ONE real
// ClientPortal login for that caller and reports whether it worked and how
// long it took, without running any order search. Counts toward the learned
// per-caller stats like any other real attempt, so testing a broken caller
// three times will open its circuit breaker (Reset learned stats clears it).
// A single login can take a minute or more on this portal.
export async function GET(request: Request) {
  if (!isDebugEnabled()) {
    return NextResponse.json({ error: "Debug tools are disabled in production." }, { status: 404 });
  }

  const wanted = new URL(request.url).searchParams.get("caller")?.trim() ?? "";
  if (!wanted) {
    return NextResponse.json({ error: "caller is required" }, { status: 400 });
  }

  const caller = xceleratorCallersFromEnv().find(
    (c) => c.label === wanted || c.cfg.username === wanted,
  );
  if (!caller) {
    return NextResponse.json({ error: `No configured caller matches "${wanted}".` }, { status: 404 });
  }

  const loginKey = caller.cfg.username ?? caller.label;
  const startedAt = Date.now();
  try {
    await loginToPortal(caller.cfg);
    const ms = Date.now() - startedAt;
    recordLoginAttempt(loginKey, ms, true);
    logDebugEvent({ kind: "login-test", query: caller.label, ms, outcome: "login ok", ok: true });
    return NextResponse.json({ caller: caller.label, ok: true, ms });
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    recordLoginAttempt(loginKey, ms, false);
    logDebugEvent({ kind: "login-test", query: caller.label, ms, outcome: "login failed", ok: false, detail: message });
    return NextResponse.json({ caller: caller.label, ok: false, ms, error: message });
  }
}
