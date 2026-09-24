import { NextResponse } from "next/server";
import { logDebugEvent } from "@/lib/debug-log";
import { findOrderWithWebAgent, WebAgentError } from "@/lib/web-agent";

// A browser session plus several model turns per caller takes a while.
export const maxDuration = 300;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ referenceNumber: string }> },
) {
  const { referenceNumber } = await params;
  const startedAt = Date.now();

  try {
    const result = await findOrderWithWebAgent(referenceNumber);
    const ms = Date.now() - startedAt;
    logDebugEvent({
      kind: "lookup",
      query: `[web agent] ${referenceNumber}`,
      ms,
      outcome: result.order ? `found via web agent (${result.foundViaCaller})` : "not found",
      ok: Boolean(result.order),
      detail: result.warning,
    });

    if (!result.order) {
      return NextResponse.json(
        { error: "Order not found", warning: result.warning, steps: result.steps },
        { status: 404 },
      );
    }
    return NextResponse.json({
      order: result.order,
      source: "web-agent",
      foundViaCaller: result.foundViaCaller,
      orderTrackingId: result.orderTrackingId,
      warning: result.warning,
      steps: result.steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Web agent lookup failed";
    const status = err instanceof WebAgentError ? err.status : 500;
    logDebugEvent({
      kind: "lookup",
      query: `[web agent] ${referenceNumber}`,
      ms: Date.now() - startedAt,
      outcome: `error ${status}`,
      ok: false,
      detail: message,
    });
    return NextResponse.json(
      { error: message, steps: err instanceof WebAgentError ? err.steps : [] },
      { status },
    );
  }
}
