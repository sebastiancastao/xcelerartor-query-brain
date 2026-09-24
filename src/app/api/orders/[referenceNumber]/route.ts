import { NextResponse } from "next/server";
import { logDebugEvent } from "@/lib/debug-log";
import { getOrderByReferenceNumberDetailed } from "@/lib/xcelerator";
import { XceleratorPortalError } from "@/lib/xcelerator-portal";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ referenceNumber: string }> },
) {
  const { referenceNumber } = await params;
  const startedAt = Date.now();
  let result;
  try {
    result = await getOrderByReferenceNumberDetailed(referenceNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order lookup failed";
    const status = err instanceof XceleratorPortalError ? (err.status ?? 502) : 500;
    logDebugEvent({
      kind: "lookup",
      query: referenceNumber,
      ms: Date.now() - startedAt,
      outcome: `error ${status}`,
      ok: false,
      detail: message,
    });
    return NextResponse.json({ error: message }, { status });
  }

  const ms = Date.now() - startedAt;
  if (!result.order) {
    logDebugEvent({
      kind: "lookup",
      query: referenceNumber,
      ms,
      outcome: "not found",
      ok: false,
      detail: result.warning,
    });
    return NextResponse.json({ error: "Order not found", warning: result.warning }, { status: 404 });
  }

  logDebugEvent({
    kind: "lookup",
    query: referenceNumber,
    ms,
    outcome: `found via ${result.source}`,
    ok: true,
    detail: result.warning,
  });
  return NextResponse.json({
    order: result.order,
    source: result.source,
    warning: result.warning,
  });
}
