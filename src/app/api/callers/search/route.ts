import { NextResponse } from "next/server";
import { logDebugEvent } from "@/lib/debug-log";
import { searchOrdersByCaller } from "@/lib/xcelerator";

// GET /api/callers/search?q=... — finds orders by the caller's name,
// department, phone, or email rather than a reference number, for the case
// where a CSR only has "who's on the phone" to go on. See
// searchOrdersByCaller's comment in xcelerator.ts for why this stays cheap
// even across several different searches: it's backed by a shared 60s cache
// of the same bulk order list the reference-number fallback search uses, so
// it costs at most one real Xcelerator/Axis call per minute, not one per
// caller searched.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";

  if (!q.trim()) {
    return NextResponse.json({ matches: [], source: "mock" });
  }

  const startedAt = Date.now();
  try {
    const result = await searchOrdersByCaller(q);
    logDebugEvent({
      kind: "caller-search",
      query: q,
      ms: Date.now() - startedAt,
      outcome: `${result.matches.length} match${result.matches.length === 1 ? "" : "es"} via ${result.source}`,
      ok: true,
      detail: result.warning,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Caller search failed";
    logDebugEvent({
      kind: "caller-search",
      query: q,
      ms: Date.now() - startedAt,
      outcome: "error 502",
      ok: false,
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
