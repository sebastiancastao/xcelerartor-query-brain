import { NextResponse } from "next/server";
import { probeAxisReference } from "@/lib/axis-api";
import { isDebugEnabled, logDebugEvent } from "@/lib/debug-log";

// GET /api/debug/axis-probe?ref=... — one raw Axis GetOrderByReference call
// and exactly what came back (status, timing, start of the body), with no
// mapping and no fallback. The point is telling "401 wrong credential" from
// "200 but no such order" from "couldn't reach Axis" without reading logs.
export async function GET(request: Request) {
  if (!isDebugEnabled()) {
    return NextResponse.json({ error: "Debug tools are disabled in production." }, { status: 404 });
  }

  const ref = new URL(request.url).searchParams.get("ref")?.trim() ?? "";
  if (!ref) {
    return NextResponse.json({ error: "ref is required" }, { status: 400 });
  }

  const result = await probeAxisReference(ref);
  logDebugEvent({
    kind: "axis-probe",
    query: ref,
    ms: result.elapsedMs,
    outcome: result.status !== null ? `HTTP ${result.status}` : "no response",
    ok: result.ok,
    detail: result.error ?? undefined,
  });
  return NextResponse.json(result);
}
