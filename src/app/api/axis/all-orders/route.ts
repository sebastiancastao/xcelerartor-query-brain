import { NextResponse } from "next/server";
import {
  AxisApiError,
  chargeLineItems,
  getAllOrdersFromAxisRaw,
  isAxisApiConfigured,
  type TrackOrderV4Response,
} from "@/lib/axis-api";
import { getAllOrdersFromXceleratorPortal, type PortalOrderRow } from "@/lib/xcelerator";
import { xceleratorConfigFromEnv } from "@/lib/xcelerator-portal";

// This deployment's real order history doesn't skew recent — a live probe
// turned up orders from Dec 2025 through Apr 2026, none inside the last 30
// days — so a short default window silently returns zero rows even when
// the call itself succeeds. A wider default makes a plain click on the
// debug button actually show something; ?from=/?to= override it.
const DEFAULT_LOOKBACK_DAYS = 365;

// Deliberately as wide as each source actually offers — this is the raw-debug
// endpoint, so the point is to show everything Axis (or the ClientPortal
// fallback) sends back rather than the trimmed-down shape CompletedOrderSummary/
// OrderInquiry use elsewhere. Fields the current source can't supply (the
// ClientPortal list endpoint has no pickup/delivery target or arrival times
// and no itemized charge breakdown — see PortalOrderRow's comment in
// xcelerator.ts) come back null/empty rather than guessed at.
type DebugOrderRow = {
  orderTrackingId: string | null;
  accountNo: string | null;
  oDate: string | null;
  status: string | null;
  clientRefNo: string | null;
  pickupCompany: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupTargetFrom: string | null;
  pickupArrival: string | null;
  deliveryCompany: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryTargetFrom: string | null;
  deliveryArrival: string | null;
  podCompletion: string | null;
  hasPodSignature: boolean | null;
  podName: string | null;
  grandTotal: number | null;
  chargeBreakdown: { label: string; amount: number }[];
  documents: { name: string | null; fileFormat: string | null }[];
};

function fromAxisOrder(order: TrackOrderV4Response): DebugOrderRow {
  return {
    orderTrackingId: String(order.OrderTrackingId),
    accountNo: order.AccountNo ?? null,
    oDate: order.oDate ?? null,
    status: order.Status ?? null,
    clientRefNo: order.ClientRefNo ?? null,
    pickupCompany: order.PCoName ?? null,
    pickupCity: order.PCity ?? null,
    pickupState: order.PState ?? null,
    pickupTargetFrom: order.PickupTargetFrom ?? null,
    pickupArrival: order.PickupArrival ?? null,
    deliveryCompany: order.DCoName ?? null,
    deliveryCity: order.DCity ?? null,
    deliveryState: order.DState ?? null,
    deliveryTargetFrom: order.DeliveryTargetFrom ?? null,
    deliveryArrival: order.DeliveryArrival ?? null,
    podCompletion: order.PODcompletion ?? null,
    hasPodSignature: order.HasPODsignature ?? null,
    podName: order.PODname ?? null,
    grandTotal: typeof order.GrandTotal === "number" ? order.GrandTotal : null,
    chargeBreakdown: chargeLineItems(order),
    documents: (order.OrderDocuments ?? []).map((doc) => ({
      name: doc.Name ?? doc.Details ?? null,
      fileFormat: doc.FileFormat ?? null,
    })),
  };
}

function fromPortalRow(row: PortalOrderRow): DebugOrderRow {
  return {
    orderTrackingId: row.orderTrackingId,
    accountNo: row.accountNo,
    oDate: null,
    status: row.status !== null ? String(row.status) : null,
    clientRefNo: row.clientRefNo,
    pickupCompany: row.pickupCompany,
    pickupCity: row.pickupCity,
    pickupState: row.pickupState,
    pickupTargetFrom: null,
    pickupArrival: null,
    deliveryCompany: row.deliveryCompany,
    deliveryCity: row.deliveryCity,
    deliveryState: row.deliveryState,
    deliveryTargetFrom: null,
    deliveryArrival: row.deliveryArrival,
    podCompletion: row.podCompletion,
    hasPodSignature: row.podCompletion !== null ? Boolean(row.podCompletion) : null,
    podName: null,
    grandTotal: row.grandTotal,
    chargeBreakdown: [],
    documents: [],
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "from/to must be valid dates" }, { status: 400 });
  }

  let axisError: unknown = null;

  // Try the real Axis REST API first — this is the literal /v4/Order/GetAllOrders
  // call. Its Authorization header format is unconfirmed against this deployment
  // (see axis-api.ts's header comment), so on failure this falls back to the
  // ClientPortal session instead of just erroring out.
  if (isAxisApiConfigured()) {
    try {
      const orders = await getAllOrdersFromAxisRaw(from, to);
      return NextResponse.json({
        source: "axis",
        count: orders.length,
        orders: orders.map(fromAxisOrder),
      });
    } catch (err) {
      axisError = err;
      console.warn(
        "Axis raw GetAllOrders failed, falling back to ClientPortal getorders:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const axisFailureMessage =
    axisError instanceof Error ? axisError.message : axisError ? String(axisError) : null;

  const portalCfg = xceleratorConfigFromEnv();
  if (!(portalCfg.username && portalCfg.password)) {
    if (axisFailureMessage) {
      const status = axisError instanceof AxisApiError ? (axisError.status ?? 502) : 502;
      return NextResponse.json({ error: axisFailureMessage }, { status });
    }
    return NextResponse.json(
      {
        error:
          "Neither the Axis API nor the ClientPortal are configured. Set AXIS_API_TOKEN / AXIS_USERNAME+AXIS_PASSWORD, or XCELERATOR_USERNAME+XCELERATOR_PASSWORD.",
      },
      { status: 400 },
    );
  }

  try {
    const rows = await getAllOrdersFromXceleratorPortal(from, to, portalCfg);
    return NextResponse.json({
      source: "portal",
      count: rows.length,
      orders: rows.map(fromPortalRow),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ClientPortal getorders failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
