import { NextResponse } from "next/server";
import { getOrderByReferenceNumberDetailed } from "@/lib/xcelerator";
import { XceleratorPortalError } from "@/lib/xcelerator-portal";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ referenceNumber: string }> },
) {
  const { referenceNumber } = await params;
  let result;
  try {
    result = await getOrderByReferenceNumberDetailed(referenceNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order lookup failed";
    const status = err instanceof XceleratorPortalError ? (err.status ?? 502) : 500;
    return NextResponse.json({ error: message }, { status });
  }

  if (!result.order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  return NextResponse.json({
    order: result.order,
    source: result.source,
  });
}
