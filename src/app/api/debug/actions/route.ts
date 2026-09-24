import { NextResponse } from "next/server";
import { clearDebugEvents, isDebugEnabled } from "@/lib/debug-log";
import { resetLoginPerformance } from "@/lib/login-performance";
import { clearLookupCaches } from "@/lib/xcelerator";

// POST /api/debug/actions  { "action": "clear-caches" | "reset-performance" | "clear-events" }
// The three things worth being able to do from the debug page. None touches
// Xcelerator, Axis, or any credential: they only reset this server's own
// in-memory state.
const ACTIONS = {
  "clear-caches": clearLookupCaches,
  "reset-performance": resetLoginPerformance,
  "clear-events": clearDebugEvents,
} as const;

export async function POST(request: Request) {
  if (!isDebugEnabled()) {
    return NextResponse.json({ error: "Debug tools are disabled in production." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (typeof action !== "string" || !(action in ACTIONS)) {
    return NextResponse.json(
      { error: `action must be one of: ${Object.keys(ACTIONS).join(", ")}` },
      { status: 400 },
    );
  }

  ACTIONS[action as keyof typeof ACTIONS]();
  return NextResponse.json({ ok: true, action });
}
