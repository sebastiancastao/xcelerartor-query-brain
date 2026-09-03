import {
  loginToPortal,
  portalJson,
  postPortalJson,
  xceleratorConfigFromEnv,
  XceleratorPortalError,
  type XceleratorPortalConfig,
} from "./xcelerator-portal";
import {
  getCompletedOrdersFromAxis,
  getOrderByReferenceFromAxis,
  isAxisApiConfigured,
} from "./axis-api";

export type OrderStatus = "pending_pickup" | "in_transit" | "delivered";

export interface OrderInquiry {
  referenceNumber: string;
  customer: string;
  carrier: string;
  status: OrderStatus;
  pickup: {
    location: string;
    scheduledAt: string;
    arrived: boolean;
    arrivedAt: string | null;
  };
  delivery: {
    location: string;
    scheduledAt: string;
    delivered: boolean;
    deliveredAt: string | null;
  };
  pod: {
    available: boolean;
    receivedBy: string | null;
    documentUrl: string | null;
  };
  charges: {
    currency: string;
    total: number;
    finalized: boolean;
    lineItems: { label: string; amount: number }[];
  };
}

export interface CompletedOrderSummary {
  referenceNumber: string;
  orderTrackingId: string | null;
  customer: string;
  carrier: string;
  pickupLocation: string;
  deliveryLocation: string;
  completedAt: string;
  podAvailable: boolean;
  charges: {
    currency: string;
    total: number;
    finalized: boolean;
  };
}

const MOCK_ORDERS: Record<string, OrderInquiry> = {
  "REF-1001": {
    referenceNumber: "REF-1001",
    customer: "Acme Manufacturing",
    carrier: "Redline Freight",
    status: "pending_pickup",
    pickup: {
      location: "Dallas, TX",
      scheduledAt: "2026-08-29T08:00:00-05:00",
      arrived: false,
      arrivedAt: null,
    },
    delivery: {
      location: "Memphis, TN",
      scheduledAt: "2026-08-30T14:00:00-05:00",
      delivered: false,
      deliveredAt: null,
    },
    pod: { available: false, receivedBy: null, documentUrl: null },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
  },
  "REF-1002": {
    referenceNumber: "REF-1002",
    customer: "Blue Harbor Foods",
    carrier: "Redline Freight",
    status: "in_transit",
    pickup: {
      location: "Savannah, GA",
      scheduledAt: "2026-08-27T09:00:00-04:00",
      arrived: true,
      arrivedAt: "2026-08-27T09:12:00-04:00",
    },
    delivery: {
      location: "Charlotte, NC",
      scheduledAt: "2026-08-28T16:00:00-04:00",
      delivered: false,
      deliveredAt: null,
    },
    pod: { available: false, receivedBy: null, documentUrl: null },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
  },
  "REF-1003": {
    referenceNumber: "REF-1003",
    customer: "Northwind Distribution",
    carrier: "Summit Logistics",
    status: "delivered",
    pickup: {
      location: "Portland, OR",
      scheduledAt: "2026-08-24T07:30:00-07:00",
      arrived: true,
      arrivedAt: "2026-08-24T07:41:00-07:00",
    },
    delivery: {
      location: "Boise, ID",
      scheduledAt: "2026-08-25T13:00:00-06:00",
      delivered: true,
      deliveredAt: "2026-08-25T12:47:00-06:00",
    },
    pod: {
      available: true,
      receivedBy: "M. Alvarez (Receiving)",
      documentUrl: "https://example.com/pod/REF-1003.pdf",
    },
    charges: {
      currency: "USD",
      total: 1875.5,
      finalized: true,
      lineItems: [
        { label: "Linehaul", amount: 1600 },
        { label: "Fuel surcharge", amount: 210.5 },
        { label: "Lumper fee", amount: 65 },
      ],
    },
  },
  "REF-1004": {
    referenceNumber: "REF-1004",
    customer: "Cascade Retail Group",
    carrier: "Summit Logistics",
    status: "delivered",
    pickup: {
      location: "Reno, NV",
      scheduledAt: "2026-08-25T10:00:00-07:00",
      arrived: true,
      arrivedAt: "2026-08-25T10:05:00-07:00",
    },
    delivery: {
      location: "Sacramento, CA",
      scheduledAt: "2026-08-26T09:00:00-07:00",
      delivered: true,
      deliveredAt: "2026-08-26T09:22:00-07:00",
    },
    pod: {
      available: true,
      receivedBy: "Front Desk",
      documentUrl: "https://example.com/pod/REF-1004.pdf",
    },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
  },
};

const MOCK_LATENCY_MS = 350;

export function isXceleratorConfigured(): boolean {
  const cfg = xceleratorConfigFromEnv();
  return Boolean(cfg.username && cfg.password);
}

export type OrderLookupSource = "axis" | "portal" | "mock";

export type OrderLookupResult = {
  order: OrderInquiry | null;
  source: OrderLookupSource;
  /** Set when Axis failed and the ClientPortal fallback was used instead. */
  warning?: string;
};

/**
 * Axis-first, ClientPortal-fallback order lookup by reference number, same
 * pattern as getCompletedOrdersByDateRange/getAllOrdersFromXceleratorPortal
 * below. Unlike the plain getOrderByReferenceNumber wrapper, this reports
 * which source actually answered the request (and the real Axis error, if
 * any) so callers that want to show that to a user — the order-lookup UI —
 * can, instead of silently masking the fallback like the wrapper does for
 * agent.ts's tool-calling use.
 */
export async function getOrderByReferenceNumberDetailed(
  referenceNumber: string,
): Promise<OrderLookupResult> {
  let axisFailureMessage: string | undefined;

  // Prefer the real Axis REST API (src/lib/axis-api.ts) when configured. Its
  // Authorization header format is unconfirmed (see that file's header
  // comment), so any failure there — auth included — falls back to the
  // proven ClientPortal session lookup below rather than surfacing an error.
  if (isAxisApiConfigured()) {
    try {
      const order = await getOrderByReferenceFromAxis(referenceNumber);
      return { order, source: "axis" };
    } catch (err) {
      axisFailureMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        "Axis REST API order lookup failed, falling back to ClientPortal session lookup:",
        axisFailureMessage,
      );
    }
  }

  const cfg = xceleratorConfigFromEnv();
  if (cfg.username && cfg.password) {
    const order = await getOrderFromXcelerator(referenceNumber, cfg);
    if (order) {
      return {
        order,
        source: "portal",
        warning: axisFailureMessage
          ? `Axis order lookup failed, showing ClientPortal data instead: ${axisFailureMessage}`
          : undefined,
      };
    }

    // getorderproperties (the endpoint getOrderFromXcelerator just tried)
    // has narrower visibility than getorders — confirmed live, it returns
    // Data: [] for real orders getorders finds fine. Try that broader
    // search before giving up.
    const bulkOrder = await getOrderByReferenceFromXceleratorBulkSearch(referenceNumber, cfg);
    if (bulkOrder) {
      return {
        order: bulkOrder,
        source: "portal",
        warning: [
          axisFailureMessage ? `Axis order lookup failed (${axisFailureMessage}).` : null,
          "ClientPortal's order-detail search found nothing, so this is limited data from the order list instead — pickup arrival time and itemized charges aren't available this way.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }

    return {
      order: null,
      source: "portal",
      warning: axisFailureMessage
        ? `Axis order lookup failed, and ClientPortal found no match either: ${axisFailureMessage}`
        : undefined,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));
  const key = referenceNumber.trim().toUpperCase();
  return { order: MOCK_ORDERS[key] ?? null, source: "mock" };
}

export async function getOrderByReferenceNumber(
  referenceNumber: string,
): Promise<OrderInquiry | null> {
  const result = await getOrderByReferenceNumberDetailed(referenceNumber);
  return result.order;
}

export async function getCompletedOrdersByDateRange(
  start: Date,
  end: Date,
): Promise<CompletedOrderSummary[]> {
  // Same Axis-first, ClientPortal-fallback pattern as getOrderByReferenceNumber
  // above — see that function's comment and axis-api.ts's header for why the
  // Axis path can fail (auth format still unconfirmed).
  if (isAxisApiConfigured()) {
    try {
      const orders = await getCompletedOrdersFromAxis(start, end);
      return orders
        .filter((order) => dateInRange(order.completedAt, start, end))
        .sort(compareCompletedAt);
    } catch (err) {
      console.warn(
        "Axis REST API completed-orders lookup failed, falling back to ClientPortal session lookup:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const cfg = xceleratorConfigFromEnv();
  if (cfg.username && cfg.password) {
    return getCompletedOrdersFromXcelerator(start, end, cfg);
  }

  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));
  return Object.values(MOCK_ORDERS)
    .map(toCompletedOrderSummary)
    .filter((order): order is CompletedOrderSummary => Boolean(order))
    .filter((order) => dateInRange(order.completedAt, start, end))
    .sort(compareCompletedAt);
}

// --- Real Xcelerator ClientPortal lookup ------------------------------------
//
// Endpoint and field names below were captured live from the ClientPortal
// (POST /ClientPortal/ClientPortal/api/trackingOnline/getorderproperties,
// the same call the portal's own "Order Properties" panel makes) and cross
// checked against the portal's client-side QuickTrack.js and Tracking.js.
// Detail status is a 1-10 stepper code; 9 = "Delivery Complete". The Tracking
// grid's status filter uses "4" for completed deliveries.

type PortalChargeDetailItem = { Field: string; Price: string };

type PortalOrderProperties = {
  OrderTrackingID: number;
  Status: number;
  ClientRefNo: string | null;
  PCoName: string | null;
  PCity: string | null;
  PState: string | null;
  PickupTargetFrom: string | null;
  PickupArrival: string | null;
  DCoName: string | null;
  DCity: string | null;
  DState: string | null;
  DeliveryTargetFrom: string | null;
  DeliveryArrival: string | null;
  PODcompletion?: string | null;
  PODSignature: string | null;
  ChargeDetailItems: PortalChargeDetailItem[] | null;
};

type PortalOrderPropertiesResponse = {
  Data: PortalOrderProperties[] | null;
  Error: string | null;
};

type PortalOrderLookupField = (typeof ORDER_LOOKUP_FIELDS)[number];

type PortalOrderListRow = {
  OrderTrackingID: number | string | null;
  Status: number | null;
  ClientRefNo: string | null;
  PCoName: string | null;
  PCity: string | null;
  PState: string | null;
  DCoName: string | null;
  DCity: string | null;
  DState: string | null;
  DeliveryArrival: string | null;
  PODcompletion: string | null;
  GrandTotal: number | string | null;
};

type PortalOrderListResponse = {
  Data: PortalOrderListRow[] | null;
  Count: number;
  Error?: string | null;
};

const DELIVERY_COMPLETE_STATUS = 9;
const TRACKING_DELIVERY_COMPLETE_FILTER = "4";
// Confirmed live against this deployment's getorders endpoint: Status=4,
// Status=0, and an empty Status all returned only delivery-complete rows;
// Status=-1 additionally returned in-progress ones. Matches the -1="all"
// convention ClientIDs already uses on this same endpoint.
const TRACKING_ALL_STATUSES_FILTER = "-1";
const DEFAULT_TRACKING_CLIENT_IDS = "-1";
const DEFAULT_TARGET_DATE_BUFFER_DAYS = 7;
const ORDER_LOOKUP_FIELDS = [
  "o.OrderTrackingID",
  "o.ClientRefNo",
  "o.ClientRefNo2",
  "o.ClientRefNo3",
  "o.ClientRefNo4",
  "opi.RefNo",
  "opi.RefNo2",
] as const;

function parsePortalPrice(value: string): number {
  const n = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parsePortalAmount(value: number | string | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return parsePortalPrice(value);
  return 0;
}

function dateInRange(value: string, start: Date, end: Date): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime();
}

function compareCompletedAt(a: CompletedOrderSummary, b: CompletedOrderSummary): number {
  return new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime();
}

function toCompletedOrderSummary(order: OrderInquiry): CompletedOrderSummary | null {
  if (!order.delivery.delivered || !order.delivery.deliveredAt) return null;

  return {
    referenceNumber: order.referenceNumber,
    orderTrackingId: null,
    customer: order.customer,
    carrier: order.carrier,
    pickupLocation: order.pickup.location,
    deliveryLocation: order.delivery.location,
    completedAt: order.delivery.deliveredAt,
    podAvailable: order.pod.available,
    charges: {
      currency: order.charges.currency,
      total: order.charges.total,
      finalized: order.charges.finalized,
    },
  };
}

function formatLocation(city: string | null, state: string | null): string {
  return [city, state].filter(Boolean).join(", ");
}

function formatOrderTrackingId(value: number | string | null): string | null {
  if (typeof value === "number") return value.toFixed(6);
  const text = value?.toString().trim();
  return text || null;
}

function mapPortalOrderListRowToSummary(row: PortalOrderListRow): CompletedOrderSummary | null {
  const completedAt = row.PODcompletion ?? row.DeliveryArrival;
  if (!completedAt) return null;

  return {
    referenceNumber: row.ClientRefNo || formatOrderTrackingId(row.OrderTrackingID) || "Unknown",
    orderTrackingId: formatOrderTrackingId(row.OrderTrackingID),
    customer: row.PCoName ?? row.DCoName ?? "Unknown",
    carrier: "Skyline Courier & Logistics",
    pickupLocation: formatLocation(row.PCity, row.PState),
    deliveryLocation: formatLocation(row.DCity, row.DState),
    completedAt,
    podAvailable: Boolean(row.PODcompletion),
    charges: {
      currency: "USD",
      total: parsePortalAmount(row.GrandTotal),
      finalized: row.GrandTotal !== null,
    },
  };
}

// PortalOrderListRow (the getorders bulk-list row) doesn't carry pickup
// arrival/target times or itemized charges — getorderproperties (single
// lookup) does, when it finds a match — so this mapping is necessarily
// lower-fidelity than mapPortalOrderToInquiry. It exists only as the last
// resort in getOrderByReferenceNumberDetailed below, for orders
// getorderproperties can't see but getorders can (confirmed live: the two
// endpoints have different visibility into the same account's orders).
function mapPortalOrderListRowToInquiryFallback(row: PortalOrderListRow): OrderInquiry {
  const completedAt = row.PODcompletion ?? row.DeliveryArrival ?? null;
  const delivered = row.Status === DELIVERY_COMPLETE_STATUS || Boolean(completedAt);
  const trackingId = formatOrderTrackingId(row.OrderTrackingID);

  return {
    referenceNumber: row.ClientRefNo || trackingId || "Unknown",
    customer: row.PCoName ?? row.DCoName ?? "Unknown",
    carrier: "Skyline Courier & Logistics",
    status: delivered ? "delivered" : "pending_pickup",
    pickup: {
      location: formatLocation(row.PCity, row.PState),
      scheduledAt: "",
      arrived: false,
      arrivedAt: null,
    },
    delivery: {
      location: formatLocation(row.DCity, row.DState),
      scheduledAt: "",
      delivered,
      deliveredAt: completedAt,
    },
    pod: {
      available: Boolean(row.PODcompletion),
      receivedBy: null,
      documentUrl: null,
    },
    charges: {
      currency: "USD",
      total: parsePortalAmount(row.GrandTotal),
      finalized: row.GrandTotal !== null,
      lineItems: [],
    },
  };
}

function mapPortalOrderToInquiry(props: PortalOrderProperties): OrderInquiry {
  const lineItems = (props.ChargeDetailItems ?? []).map((item) => ({
    label: item.Field,
    amount: parsePortalPrice(item.Price),
  }));
  const completedAt = props.DeliveryArrival ?? props.PODcompletion ?? null;
  const delivered = props.Status === DELIVERY_COMPLETE_STATUS || Boolean(completedAt);
  const orderTrackingId = formatOrderTrackingId(props.OrderTrackingID);

  return {
    referenceNumber: props.ClientRefNo || orderTrackingId || "Unknown",
    customer: props.PCoName ?? props.DCoName ?? "Unknown",
    carrier: "Skyline Courier & Logistics",
    status: delivered ? "delivered" : props.PickupArrival ? "in_transit" : "pending_pickup",
    pickup: {
      location: [props.PCity, props.PState].filter(Boolean).join(", "),
      scheduledAt: props.PickupTargetFrom ?? "",
      arrived: Boolean(props.PickupArrival),
      arrivedAt: props.PickupArrival,
    },
    delivery: {
      location: formatLocation(props.DCity, props.DState),
      scheduledAt: props.DeliveryTargetFrom ?? "",
      delivered,
      deliveredAt: completedAt,
    },
    pod: {
      available: Boolean(props.PODSignature && props.PODSignature.length > 0),
      receivedBy: null,
      documentUrl: props.PODSignature ? `data:image/jpeg;base64,${props.PODSignature}` : null,
    },
    charges: {
      currency: "USD",
      total: lineItems.reduce((sum, item) => sum + item.amount, 0),
      finalized: lineItems.length > 0,
      lineItems,
    },
  };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function mmddyyyy(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}/${date.getFullYear()}`;
}

function targetDateBufferDays(): number {
  const raw = Number.parseInt(process.env.XCELERATOR_ORDER_QUERY_TARGET_BUFFER_DAYS || "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_TARGET_DATE_BUFFER_DAYS;
  return Math.max(0, Math.min(raw, 90));
}

async function lookupOrderProperties(
  session: Awaited<ReturnType<typeof loginToPortal>>,
  searchBy: PortalOrderLookupField,
  search: string,
): Promise<PortalOrderProperties | null> {
  const result = await postPortalJson<PortalOrderPropertiesResponse>(
    session,
    "/ClientPortal/ClientPortal/api/trackingOnline/getorderproperties",
    { _SearchBy: searchBy, _Search: search, _Key: "" },
  );

  if (result.Error) {
    throw new XceleratorPortalError(result.Error);
  }

  return result.Data?.find((props) => Boolean(props.OrderTrackingID)) ?? null;
}

async function fetchPortalOrderRows(
  status: string,
  start: Date,
  end: Date,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
): Promise<PortalOrderListRow[]> {
  const session = await loginToPortal(cfg);
  const bufferDays = targetDateBufferDays();
  const params = new URLSearchParams({
    ServiceIDs: process.env.XCELERATOR_TRACKING_SERVICE_IDS || "0",
    VehicleIDs: process.env.XCELERATOR_TRACKING_VEHICLE_IDS || "0",
    PackageIDs: process.env.XCELERATOR_TRACKING_PACKAGE_IDS || "0",
    ClientIDs: process.env.XCELERATOR_TRACKING_CLIENT_IDS || DEFAULT_TRACKING_CLIENT_IDS,
    Status: status,
    OrderTrackingID: "",
    ClientRefNo: "",
    ClientRefNo2: "",
    Caller: "",
    PickupCompany: "",
    DeliveryCompany: "",
    oDate_From: "",
    oDate_To: "",
    PickupTargetDateStart: "",
    PickupTargetDateEnd: "",
    DeliveryTargetDateStart: mmddyyyy(addDays(start, -bufferDays)),
    DeliveryTargetDateEnd: mmddyyyy(addDays(end, bufferDays)),
    WildCardField: "",
    WildCardValue: "",
  });

  const result = await portalJson<PortalOrderListResponse>(
    session,
    `/ClientPortal/ClientPortal/api/trackingOnline/getorders?${params.toString()}`,
  );

  if (result.Error) {
    throw new XceleratorPortalError(result.Error);
  }

  return result.Data ?? [];
}

async function getCompletedOrdersFromXcelerator(
  start: Date,
  end: Date,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
): Promise<CompletedOrderSummary[]> {
  const rows = await fetchPortalOrderRows(TRACKING_DELIVERY_COMPLETE_FILTER, start, end, cfg);

  return rows
    .map(mapPortalOrderListRowToSummary)
    .filter((order): order is CompletedOrderSummary => Boolean(order))
    .filter((order) => dateInRange(order.completedAt, start, end))
    .sort(compareCompletedAt);
}

export type PortalOrderRow = {
  orderTrackingId: string | null;
  clientRefNo: string | null;
  status: number | null;
  pickupCompany: string | null;
  deliveryCompany: string | null;
};

/**
 * All orders (any status) via the ClientPortal session — the fallback for
 * the raw-debug "GetAllOrders" button when the Axis REST API 401s (auth
 * format still unconfirmed, see axis-api.ts). Uses Status=-1, matching the
 * -1="all" convention ClientIDs already uses on this same getorders
 * endpoint (see TRACKING_ALL_STATUSES_FILTER above).
 */
export async function getAllOrdersFromXceleratorPortal(
  start: Date,
  end: Date,
  cfg: XceleratorPortalConfig = xceleratorConfigFromEnv(),
): Promise<PortalOrderRow[]> {
  const rows = await fetchPortalOrderRows(TRACKING_ALL_STATUSES_FILTER, start, end, cfg);

  return rows.map((row) => ({
    orderTrackingId: formatOrderTrackingId(row.OrderTrackingID),
    clientRefNo: row.ClientRefNo,
    status: row.Status,
    pickupCompany: row.PCoName,
    deliveryCompany: row.DCoName,
  }));
}

const BULK_SEARCH_LOOKBACK_DAYS = 730;
const TRACKING_ID_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Last-resort single-order lookup: searches the same all-statuses
 * getorders row set getAllOrdersFromXceleratorPortal uses (proven live to
 * see orders getorderproperties/getOrderFromXcelerator below can't) for a
 * row whose OrderTrackingID or ClientRefNo matches. Only reached when both
 * Axis and the normal ClientPortal single-order lookup have already come up
 * empty. Returns lower-fidelity data — see mapPortalOrderListRowToInquiryFallback.
 */
async function getOrderByReferenceFromXceleratorBulkSearch(
  referenceNumber: string,
  cfg: XceleratorPortalConfig,
): Promise<OrderInquiry | null> {
  const search = referenceNumber.trim();
  if (!search) return null;

  const end = new Date();
  const start = addDays(end, -BULK_SEARCH_LOOKBACK_DAYS);
  const rows = await fetchPortalOrderRows(TRACKING_ALL_STATUSES_FILTER, start, end, cfg);

  const isTrackingId = TRACKING_ID_PATTERN.test(search);
  const match = rows.find((row) =>
    isTrackingId
      ? formatOrderTrackingId(row.OrderTrackingID) === search
      : (row.ClientRefNo ?? "").trim().toLowerCase() === search.toLowerCase(),
  );

  return match ? mapPortalOrderListRowToInquiryFallback(match) : null;
}

async function getOrderFromXcelerator(
  referenceNumber: string,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
): Promise<OrderInquiry | null> {
  const search = referenceNumber.trim();
  if (!search) return null;

  const session = await loginToPortal(cfg);
  for (const searchBy of ORDER_LOOKUP_FIELDS) {
    const props = await lookupOrderProperties(session, searchBy, search);
    if (props) return mapPortalOrderToInquiry(props);
  }

  return null;
}

export function listSampleReferenceNumbers(): string[] {
  return Object.keys(MOCK_ORDERS);
}
