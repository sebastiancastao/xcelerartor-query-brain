import {
  loginToPortal,
  portalJson,
  postPortalJson,
  xceleratorCallersFromEnv,
  xceleratorConfigFromEnv,
  XceleratorPortalError,
  type NamedXceleratorCaller,
  type PortalSession,
  type XceleratorPortalConfig,
} from "./xcelerator-portal";
import {
  getAllOrdersFromAxisRaw,
  getCompletedOrdersFromAxis,
  getOrderByReferenceFromAxis,
  isAxisApiConfigured,
  type TrackOrderV4Response,
} from "./axis-api";
import {
  loginPerformanceSnapshot,
  getAdaptiveTimeoutMs,
  recordLoginAttempt,
  shouldSkipLogin,
} from "./login-performance";
import { firstHitInPriorityOrder, type Skipped } from "./ordered-first-match";

export { loginPerformanceSnapshot };

// Resolves once `promise` settles, or rejects with a timeout error once
// `ms` elapses, whichever comes first. Doesn't cancel `promise` itself —
// there's no AbortController threaded through loginToPortal — so a call
// this gives up on keeps running in the background and, on success, still
// populates fetchPortalOrderRows' cache and login-performance.ts's
// latency history for next time. That's a deliberate feature, not a leak:
// a login that was slow this once still gets to "prove" it eventually so
// the next search's cache or adaptive timeout benefits from it.
class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Timed out waiting for "${label}" after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type OrderStatus = "pending_pickup" | "in_transit" | "delivered";

// Package-item detail (pieces/weight/dimensions), when the account uses
// individual package items — see OrderInquiry.shipment.packages below. Named
// to match both Axis's OrderPackageItemV4 and the ClientPortal's PackageItems
// row field.
export interface OrderPackageDetail {
  name: string | null;
  refNo: string | null;
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
}

export interface OrderInquiry {
  referenceNumber: string;
  /** RefNo2/3/4 — additional client reference fields on the same order. */
  referenceNumber2: string | null;
  referenceNumber3: string | null;
  referenceNumber4: string | null;
  invoiceNumber: string | null;
  customer: string;
  carrier: string;
  status: OrderStatus;
  /** Xcelerator order type code (e.g. "PD" = Pickup/Delivery, "HD" = Hold/Deliver). */
  orderType: string | null;
  service: string | null;
  vehicle: string | null;
  /** Who called in the order — distinct from the shipper/consignee contacts below. */
  caller: {
    name: string | null;
    department: string | null;
    phone: string | null;
    email: string | null;
  };
  pickup: {
    location: string;
    company: string | null;
    street: string | null;
    street2: string | null;
    zip: string | null;
    contact: string | null;
    phone: string | null;
    email: string | null;
    scheduledAt: string;
    /** Latest end of the pickup target window, when available. */
    scheduledTo: string | null;
    arrived: boolean;
    arrivedAt: string | null;
    departedAt: string | null;
    specialInstructions: string | null;
  };
  delivery: {
    location: string;
    company: string | null;
    street: string | null;
    street2: string | null;
    zip: string | null;
    contact: string | null;
    phone: string | null;
    email: string | null;
    scheduledAt: string;
    scheduledTo: string | null;
    delivered: boolean;
    deliveredAt: string | null;
    departedAt: string | null;
    specialInstructions: string | null;
  };
  shipment: {
    pieces: number | null;
    weight: number | null;
    declaredValue: number | null;
    packages: OrderPackageDetail[];
  };
  cod: {
    amount: number | null;
    location: string | null;
  };
  /** Ticket/tracking reference when this order was handed to a third-party carrier. */
  thirdPartyTrackingRefNo: string | null;
  specialInstructions: string | null;
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
  documents: { name: string | null; fileFormat: string | null }[];
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

// Fields most mock orders leave blank — real per-order data is filled in
// below only where it makes the demo more useful to look at (REF-1003).
const EMPTY_CALLER = { name: null, department: null, phone: null, email: null };
const EMPTY_SHIPMENT = { pieces: null, weight: null, declaredValue: null, packages: [] };
const EMPTY_COD = { amount: null, location: null };
const EMPTY_ADDRESS_EXTRAS = {
  company: null,
  street: null,
  street2: null,
  zip: null,
  contact: null,
  phone: null,
  email: null,
  scheduledTo: null,
  departedAt: null,
  specialInstructions: null,
};

const MOCK_ORDERS: Record<string, OrderInquiry> = {
  "REF-1001": {
    referenceNumber: "REF-1001",
    referenceNumber2: null,
    referenceNumber3: null,
    referenceNumber4: null,
    invoiceNumber: null,
    customer: "Acme Manufacturing",
    carrier: "Redline Freight",
    status: "pending_pickup",
    orderType: "PD",
    service: "Standard",
    vehicle: "Van",
    caller: EMPTY_CALLER,
    pickup: {
      location: "Dallas, TX",
      scheduledAt: "2026-08-29T08:00:00-05:00",
      arrived: false,
      arrivedAt: null,
      ...EMPTY_ADDRESS_EXTRAS,
    },
    delivery: {
      location: "Memphis, TN",
      scheduledAt: "2026-08-30T14:00:00-05:00",
      delivered: false,
      deliveredAt: null,
      ...EMPTY_ADDRESS_EXTRAS,
    },
    shipment: EMPTY_SHIPMENT,
    cod: EMPTY_COD,
    thirdPartyTrackingRefNo: null,
    specialInstructions: null,
    pod: { available: false, receivedBy: null, documentUrl: null },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
    documents: [],
  },
  "REF-1002": {
    referenceNumber: "REF-1002",
    referenceNumber2: null,
    referenceNumber3: null,
    referenceNumber4: null,
    invoiceNumber: null,
    customer: "Blue Harbor Foods",
    carrier: "Redline Freight",
    status: "in_transit",
    orderType: "PD",
    service: "Rush",
    vehicle: "Straight Truck",
    caller: EMPTY_CALLER,
    pickup: {
      location: "Savannah, GA",
      scheduledAt: "2026-08-27T09:00:00-04:00",
      arrived: true,
      arrivedAt: "2026-08-27T09:12:00-04:00",
      ...EMPTY_ADDRESS_EXTRAS,
    },
    delivery: {
      location: "Charlotte, NC",
      scheduledAt: "2026-08-28T16:00:00-04:00",
      delivered: false,
      deliveredAt: null,
      ...EMPTY_ADDRESS_EXTRAS,
    },
    shipment: EMPTY_SHIPMENT,
    cod: EMPTY_COD,
    thirdPartyTrackingRefNo: null,
    specialInstructions: null,
    pod: { available: false, receivedBy: null, documentUrl: null },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
    documents: [],
  },
  "REF-1003": {
    referenceNumber: "REF-1003",
    referenceNumber2: "PO-88213",
    referenceNumber3: null,
    referenceNumber4: null,
    invoiceNumber: "INV-40217",
    customer: "Northwind Distribution",
    carrier: "Summit Logistics",
    status: "delivered",
    orderType: "PD",
    service: "ASAP",
    vehicle: "Cargo Van",
    caller: { name: "Priya Nair", department: "Logistics", phone: "(503) 555-0148", email: "priya.nair@northwinddist.com" },
    pickup: {
      location: "Portland, OR",
      scheduledAt: "2026-08-24T07:30:00-07:00",
      arrived: true,
      arrivedAt: "2026-08-24T07:41:00-07:00",
      company: "Northwind Distribution — DC 4",
      street: "4400 NW Yeon Ave",
      street2: "Dock 12",
      zip: "97210",
      contact: "Warehouse Lead",
      phone: "(503) 555-0148",
      email: "dc4@northwinddist.com",
      scheduledTo: "2026-08-24T08:00:00-07:00",
      departedAt: "2026-08-24T07:55:00-07:00",
      specialInstructions: "Check in at dock office before loading.",
    },
    delivery: {
      location: "Boise, ID",
      scheduledAt: "2026-08-25T13:00:00-06:00",
      delivered: true,
      deliveredAt: "2026-08-25T12:47:00-06:00",
      company: "Boise Retail Partners",
      street: "1200 W Front St",
      street2: null,
      zip: "83702",
      contact: "M. Alvarez",
      phone: "(208) 555-0173",
      email: "receiving@boiseretail.com",
      scheduledTo: "2026-08-25T15:00:00-06:00",
      departedAt: "2026-08-25T12:52:00-06:00",
      specialInstructions: "Receiving closes at 4pm — arrive before then.",
    },
    shipment: {
      pieces: 3,
      weight: 640,
      declaredValue: 12000,
      packages: [
        { name: "Pallet", refNo: "PLT-9001", weight: 220, length: 48, width: 40, height: 52 },
        { name: "Pallet", refNo: "PLT-9002", weight: 220, length: 48, width: 40, height: 52 },
        { name: "Crate", refNo: "CRT-9003", weight: 200, length: 36, width: 30, height: 30 },
      ],
    },
    cod: EMPTY_COD,
    thirdPartyTrackingRefNo: null,
    specialInstructions: "Liftgate required at delivery.",
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
    documents: [{ name: "Bill of Lading", fileFormat: "PDF" }],
  },
  "REF-1004": {
    referenceNumber: "REF-1004",
    referenceNumber2: null,
    referenceNumber3: null,
    referenceNumber4: null,
    invoiceNumber: null,
    customer: "Cascade Retail Group",
    carrier: "Summit Logistics",
    status: "delivered",
    orderType: "PD",
    service: "Standard",
    vehicle: "Van",
    caller: EMPTY_CALLER,
    pickup: {
      location: "Reno, NV",
      scheduledAt: "2026-08-25T10:00:00-07:00",
      arrived: true,
      arrivedAt: "2026-08-25T10:05:00-07:00",
      ...EMPTY_ADDRESS_EXTRAS,
    },
    delivery: {
      location: "Sacramento, CA",
      scheduledAt: "2026-08-26T09:00:00-07:00",
      delivered: true,
      deliveredAt: "2026-08-26T09:22:00-07:00",
      ...EMPTY_ADDRESS_EXTRAS,
    },
    shipment: EMPTY_SHIPMENT,
    cod: EMPTY_COD,
    thirdPartyTrackingRefNo: null,
    specialInstructions: null,
    pod: {
      available: true,
      receivedBy: "Front Desk",
      documentUrl: "https://example.com/pod/REF-1004.pdf",
    },
    charges: { currency: "USD", total: 0, finalized: false, lineItems: [] },
    documents: [],
  },
};

const MOCK_LATENCY_MS = 350;

export function isXceleratorConfigured(): boolean {
  return xceleratorCallersFromEnv().length > 0;
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
  // Tracked in login-performance.ts under the "axis" key: after a few
  // consecutive failures (this deployment's known 401 — see axis-api.ts's
  // header comment — reproduces every time), this stops even trying Axis
  // for a 5-minute cooldown instead of paying for a doomed call on every
  // single lookup.
  if (isAxisApiConfigured() && !shouldSkipLogin("axis")) {
    const axisStartedAt = Date.now();
    try {
      const order = await getOrderByReferenceFromAxis(referenceNumber);
      recordLoginAttempt("axis", Date.now() - axisStartedAt, true);
      return { order, source: "axis" };
    } catch (err) {
      recordLoginAttempt("axis", Date.now() - axisStartedAt, false);
      axisFailureMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        "Axis REST API order lookup failed, falling back to ClientPortal session lookup:",
        axisFailureMessage,
      );
    }
  }

  // Every configured caller is checked the same way (see
  // xceleratorCallersFromEnv). A caller whose login fails, times out, or is
  // circuit-broken doesn't block the lookup, it's just reported as
  // unchecked below so a "not found" can't silently hide that part of the
  // search never ran.
  const callers = xceleratorCallersFromEnv();
  if (callers.length > 0) {
    const { winner, unchecked } = await lookupAcrossCallers(referenceNumber.trim(), callers);

    const notes = [
      axisFailureMessage ? `Axis order lookup failed (${axisFailureMessage}).` : null,
      ...unchecked.map((u) => `Caller "${u.label}" could not be checked (${u.message}).`),
    ];

    if (winner) {
      return {
        order: winner.hit.order,
        source: "portal",
        warning:
          [
            ...notes,
            callers.length > 1 ? `Found via caller "${winner.caller.label}".` : null,
            winner.hit.limited
              ? "ClientPortal's order-detail search found nothing, so this is limited data from the order list instead: pickup arrival time and itemized charges aren't available this way."
              : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined,
      };
    }

    return {
      order: null,
      source: "portal",
      warning:
        notes.filter(Boolean).length > 0
          ? [
              ...notes,
              callers.length > 1
                ? "None of the callers that could be checked had a match."
                : "No match either.",
            ]
              .filter(Boolean)
              .join(" ")
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

// Shape of a package-item/document row inside PackageItems/Documents on
// either ClientPortal endpoint below. Never observed populated live against
// this deployment's account (58/58 real orders had both null), so the field
// names here are inferred from Axis's confirmed-live OrderPackageItemV4 /
// OrderDocumentV4 shapes (axis-api.ts) — same underlying Xcelerator system,
// just a different API surface — rather than independently confirmed for
// the ClientPortal AJAX endpoints. Mapped defensively; a wrong guess here
// just means an empty packages/documents list, not a broken lookup.
type PortalPackageItem = {
  PackageName?: string | null;
  RefNo?: string | null;
  Weight?: number | string | null;
  Length?: number | string | null;
  Width?: number | string | null;
  Height?: number | string | null;
};

type PortalDocumentItem = {
  Name?: string | null;
  FileFormat?: string | null;
};

// PortalOrderProperties fields below Status/ChargeDetailItems/PODSignature
// are confirmed live (see this section's header comment). The rest —
// ClientRefNo2-4, InvoiceNo, CompanyName, Service, Vehicle, OrderType, the
// full P*/D* contact+address fields, SPieces/SWeight/SValue, COD/CODLoc,
// *SpecialInstructions, PackageItems, Documents — are NOT independently
// confirmed for this specific endpoint; they're carried over from the
// confirmed-live getorders row shape (PortalOrderListRow below) on the
// assumption both ClientPortal AJAX endpoints read the same underlying
// order record. mapPortalOrderToInquiry degrades gracefully (nulls, not
// throws) if any turn out absent here.
type PortalOrderProperties = {
  OrderTrackingID: number;
  Status: number;
  ClientRefNo: string | null;
  ClientRefNo2?: string | null;
  ClientRefNo3?: string | null;
  ClientRefNo4?: string | null;
  InvoiceNo?: string | null;
  CompanyName?: string | null;
  Service?: string | null;
  Vehicle?: string | null;
  OrderType?: string | null;
  PCoName: string | null;
  PContact?: string | null;
  PPhone?: string | null;
  PEmail?: string | null;
  PStreet?: string | null;
  PStreet2?: string | null;
  PCity: string | null;
  PState: string | null;
  PZip?: string | null;
  PSpecialInstructions?: string | null;
  PickupTargetFrom: string | null;
  PickupTargetTo?: string | null;
  PickupArrival: string | null;
  PickupDeparture?: string | null;
  DCoName: string | null;
  DContact?: string | null;
  DPhone?: string | null;
  DEmail?: string | null;
  DStreet?: string | null;
  DStreet2?: string | null;
  DCity: string | null;
  DState: string | null;
  DZip?: string | null;
  DSpecialInstructions?: string | null;
  DeliveryTargetFrom: string | null;
  DeliveryTargetTo?: string | null;
  DeliveryArrival: string | null;
  DeliveryDeparture?: string | null;
  SPieces?: number | null;
  SWeight?: number | string | null;
  SValue?: number | string | null;
  COD?: number | string | null;
  CODLoc?: string | null;
  SpecialInstructions?: string | null;
  PODcompletion?: string | null;
  PODname?: string | null;
  PODSignature: string | null;
  ChargeDetailItems: PortalChargeDetailItem[] | null;
  PackageItems?: PortalPackageItem[] | null;
  Documents?: PortalDocumentItem[] | null;
};

type PortalOrderPropertiesResponse = {
  Data: PortalOrderProperties[] | null;
  Error: string | null;
};

type PortalOrderLookupField = (typeof ORDER_LOOKUP_FIELDS)[number];

// Confirmed live against this deployment's getorders endpoint (2026-09-09
// probe, 58 real orders on the connected account) — every field below is a
// real key that endpoint sends back, not inferred. PackageItems, Documents,
// ChargeDetailItems, and every *SpecialInstructions field came back null on
// all 58; still typed/mapped in case another account's orders populate
// them. A large block of AutoNotify_*/*_On*/SMS_*/Push_* notification-
// preference booleans also comes back on every row and is deliberately
// left untyped here — irrelevant to order status or shipment content.
type PortalOrderListRow = {
  OrderTrackingID: number | string | null;
  Status: number | null;
  OrderType: string | null;
  AccountNo: string | null;
  CompanyName: string | null;
  ClientRefNo: string | null;
  ClientRefNo2: string | null;
  ClientRefNo3: string | null;
  ClientRefNo4: string | null;
  InvoiceNo: string | null;
  Service: string | null;
  Vehicle: string | null;
  Caller: string | null;
  Department: string | null;
  Phone: string | null;
  Email: string | null;
  SpecialInstructions: string | null;
  SPieces: number | null;
  SWeight: number | string | null;
  SValue: number | string | null;
  COD: number | string | null;
  CODLoc: string | null;
  PCoName: string | null;
  PContact: string | null;
  PPhone: string | null;
  PEmail: string | null;
  PStreet: string | null;
  PStreet2: string | null;
  PCity: string | null;
  PState: string | null;
  PZip: string | null;
  PLocRefNo: string | null;
  PSpecialInstructions: string | null;
  PickupTargetFrom: string | null;
  PickupTargetTo: string | null;
  PickupArrival: string | null;
  PickupDeparture: string | null;
  DCoName: string | null;
  DContact: string | null;
  DPhone: string | null;
  DEmail: string | null;
  DStreet: string | null;
  DStreet2: string | null;
  DCity: string | null;
  DState: string | null;
  DZip: string | null;
  DLocRefNo: string | null;
  DSpecialInstructions: string | null;
  DeliveryTargetFrom: string | null;
  DeliveryTargetTo: string | null;
  DeliveryArrival: string | null;
  DeliveryDeparture: string | null;
  PODname: string | null;
  PODcompletion: string | null;
  GrandTotal: number | string | null;
  PackageItems: PortalPackageItem[] | null;
  Documents: PortalDocumentItem[] | null;
  ChargeDetailItems: PortalChargeDetailItem[] | null;
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

function numOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = parsePortalPrice(value);
  return n;
}

function mapPortalPackageItems(items: PortalPackageItem[] | null | undefined): OrderPackageDetail[] {
  return (items ?? []).map((item) => ({
    name: item.PackageName ?? null,
    refNo: item.RefNo ?? null,
    weight: numOrNull(item.Weight),
    length: numOrNull(item.Length),
    width: numOrNull(item.Width),
    height: numOrNull(item.Height),
  }));
}

function mapPortalDocuments(
  docs: PortalDocumentItem[] | null | undefined,
): { name: string | null; fileFormat: string | null }[] {
  return (docs ?? []).map((doc) => ({ name: doc.Name ?? null, fileFormat: doc.FileFormat ?? null }));
}

// Both mapPortalOrderListRowToInquiryFallback and mapPortalOrderToInquiry
// below normalize their respective (differently-typed) row into this shape
// and hand it to buildOrderInquiryFromPortal, since the two real endpoints
// turned out to expose almost the same field set (see PortalOrderProperties'
// and PortalOrderListRow's header comments above for which side is
// confirmed-live vs inferred-by-analogy).
type NormalizedPortalOrder = {
  referenceNumber: string;
  referenceNumber2: string | null;
  referenceNumber3: string | null;
  referenceNumber4: string | null;
  invoiceNumber: string | null;
  customer: string;
  orderType: string | null;
  service: string | null;
  vehicle: string | null;
  callerName: string | null;
  callerDepartment: string | null;
  callerPhone: string | null;
  callerEmail: string | null;
  pickup: {
    location: string;
    company: string | null;
    street: string | null;
    street2: string | null;
    zip: string | null;
    contact: string | null;
    phone: string | null;
    email: string | null;
    scheduledAt: string | null;
    scheduledTo: string | null;
    arrivedAt: string | null;
    departedAt: string | null;
    specialInstructions: string | null;
  };
  delivery: {
    location: string;
    company: string | null;
    street: string | null;
    street2: string | null;
    zip: string | null;
    contact: string | null;
    phone: string | null;
    email: string | null;
    scheduledAt: string | null;
    scheduledTo: string | null;
    departedAt: string | null;
    specialInstructions: string | null;
  };
  completedAt: string | null;
  statusCode: number | null;
  pieces: number | null;
  weight: number | null;
  declaredValue: number | null;
  codAmount: number | null;
  codLocation: string | null;
  specialInstructions: string | null;
  packages: PortalPackageItem[] | null | undefined;
  documents: PortalDocumentItem[] | null | undefined;
  podReceivedBy: string | null;
  podDocumentUrl: string | null;
  podAvailable: boolean;
  charges: { total: number; finalized: boolean; lineItems: { label: string; amount: number }[] };
};

function buildOrderInquiryFromPortal(n: NormalizedPortalOrder): OrderInquiry {
  const delivered = n.statusCode === DELIVERY_COMPLETE_STATUS || Boolean(n.completedAt);
  const status: OrderStatus = delivered ? "delivered" : n.pickup.arrivedAt ? "in_transit" : "pending_pickup";

  return {
    referenceNumber: n.referenceNumber,
    referenceNumber2: n.referenceNumber2,
    referenceNumber3: n.referenceNumber3,
    referenceNumber4: n.referenceNumber4,
    invoiceNumber: n.invoiceNumber,
    customer: n.customer,
    carrier: "Skyline Courier & Logistics",
    status,
    orderType: n.orderType,
    service: n.service,
    vehicle: n.vehicle,
    caller: {
      name: n.callerName,
      department: n.callerDepartment,
      phone: n.callerPhone,
      email: n.callerEmail,
    },
    pickup: {
      location: n.pickup.location,
      company: n.pickup.company,
      street: n.pickup.street,
      street2: n.pickup.street2,
      zip: n.pickup.zip,
      contact: n.pickup.contact,
      phone: n.pickup.phone,
      email: n.pickup.email,
      scheduledAt: n.pickup.scheduledAt ?? "",
      scheduledTo: n.pickup.scheduledTo,
      arrived: Boolean(n.pickup.arrivedAt),
      arrivedAt: n.pickup.arrivedAt,
      departedAt: n.pickup.departedAt,
      specialInstructions: n.pickup.specialInstructions,
    },
    delivery: {
      location: n.delivery.location,
      company: n.delivery.company,
      street: n.delivery.street,
      street2: n.delivery.street2,
      zip: n.delivery.zip,
      contact: n.delivery.contact,
      phone: n.delivery.phone,
      email: n.delivery.email,
      scheduledAt: n.delivery.scheduledAt ?? "",
      scheduledTo: n.delivery.scheduledTo,
      delivered,
      deliveredAt: n.completedAt,
      departedAt: n.delivery.departedAt,
      specialInstructions: n.delivery.specialInstructions,
    },
    shipment: {
      pieces: n.pieces,
      weight: n.weight,
      declaredValue: n.declaredValue,
      packages: mapPortalPackageItems(n.packages),
    },
    cod: { amount: n.codAmount, location: n.codLocation },
    // Not present on either ClientPortal endpoint — only Axis's
    // TrackOrderV4Response has ThirdPartyCarrierId/ThirdPartyTrackingRefNo.
    thirdPartyTrackingRefNo: null,
    specialInstructions: n.specialInstructions,
    pod: {
      available: n.podAvailable,
      receivedBy: n.podReceivedBy,
      documentUrl: n.podDocumentUrl,
    },
    charges: {
      currency: "USD",
      total: n.charges.total,
      finalized: n.charges.finalized,
      lineItems: n.charges.lineItems,
    },
    documents: mapPortalDocuments(n.documents),
  };
}

// Last-resort fallback (see searchOrderUnderSession's
// comment) — but no longer meaningfully lower-fidelity than
// mapPortalOrderToInquiry below: pickup/delivery target and arrival times,
// full contact/address detail, and shipment weight/pieces are all present
// on the getorders row (confirmed live — see PortalOrderListRow's header
// comment above). Only itemized per-charge detail is reliably absent here
// in practice (ChargeDetailItems came back null on all 58 real orders
// checked against this deployment).
function mapPortalOrderListRowToInquiryFallback(row: PortalOrderListRow): OrderInquiry {
  const trackingId = formatOrderTrackingId(row.OrderTrackingID);

  return buildOrderInquiryFromPortal({
    referenceNumber: row.ClientRefNo || trackingId || "Unknown",
    referenceNumber2: row.ClientRefNo2 || null,
    referenceNumber3: row.ClientRefNo3 || null,
    referenceNumber4: row.ClientRefNo4 || null,
    invoiceNumber: row.InvoiceNo || null,
    customer: row.PCoName || row.DCoName || row.CompanyName || "Unknown",
    orderType: row.OrderType || null,
    service: row.Service || null,
    vehicle: row.Vehicle || null,
    callerName: row.Caller || null,
    callerDepartment: row.Department || null,
    callerPhone: row.Phone || null,
    callerEmail: row.Email || null,
    pickup: {
      location: formatLocation(row.PCity, row.PState),
      company: row.PCoName || null,
      street: row.PStreet || null,
      street2: row.PStreet2 || null,
      zip: row.PZip || null,
      contact: row.PContact || null,
      phone: row.PPhone || null,
      email: row.PEmail || null,
      scheduledAt: row.PickupTargetFrom,
      scheduledTo: row.PickupTargetTo,
      arrivedAt: row.PickupArrival,
      departedAt: row.PickupDeparture,
      specialInstructions: row.PSpecialInstructions || null,
    },
    delivery: {
      location: formatLocation(row.DCity, row.DState),
      company: row.DCoName || null,
      street: row.DStreet || null,
      street2: row.DStreet2 || null,
      zip: row.DZip || null,
      contact: row.DContact || null,
      phone: row.DPhone || null,
      email: row.DEmail || null,
      scheduledAt: row.DeliveryTargetFrom,
      scheduledTo: row.DeliveryTargetTo,
      departedAt: row.DeliveryDeparture,
      specialInstructions: row.DSpecialInstructions || null,
    },
    completedAt: row.PODcompletion ?? row.DeliveryArrival ?? null,
    statusCode: row.Status,
    pieces: row.SPieces,
    weight: numOrNull(row.SWeight),
    declaredValue: numOrNull(row.SValue),
    codAmount: numOrNull(row.COD),
    codLocation: row.CODLoc || null,
    specialInstructions: row.SpecialInstructions || null,
    packages: row.PackageItems,
    documents: row.Documents,
    podReceivedBy: row.PODname || null,
    podDocumentUrl: null,
    podAvailable: Boolean(row.PODcompletion),
    charges: {
      total: parsePortalAmount(row.GrandTotal),
      finalized: row.GrandTotal !== null,
      lineItems: (row.ChargeDetailItems ?? []).map((item) => ({
        label: item.Field,
        amount: parsePortalPrice(item.Price),
      })),
    },
  });
}

function mapPortalOrderToInquiry(props: PortalOrderProperties): OrderInquiry {
  const orderTrackingId = formatOrderTrackingId(props.OrderTrackingID);
  const lineItems = (props.ChargeDetailItems ?? []).map((item) => ({
    label: item.Field,
    amount: parsePortalPrice(item.Price),
  }));

  return buildOrderInquiryFromPortal({
    referenceNumber: props.ClientRefNo || orderTrackingId || "Unknown",
    referenceNumber2: props.ClientRefNo2 || null,
    referenceNumber3: props.ClientRefNo3 || null,
    referenceNumber4: props.ClientRefNo4 || null,
    invoiceNumber: props.InvoiceNo || null,
    customer: props.PCoName || props.DCoName || props.CompanyName || "Unknown",
    orderType: props.OrderType || null,
    service: props.Service || null,
    vehicle: props.Vehicle || null,
    // getorderproperties' confirmed-live subset never included caller
    // contact fields (see this section's header comment) — left null
    // rather than guessed.
    callerName: null,
    callerDepartment: null,
    callerPhone: null,
    callerEmail: null,
    pickup: {
      location: formatLocation(props.PCity, props.PState),
      company: props.PCoName || null,
      street: props.PStreet || null,
      street2: props.PStreet2 || null,
      zip: props.PZip || null,
      contact: props.PContact || null,
      phone: props.PPhone || null,
      email: props.PEmail || null,
      scheduledAt: props.PickupTargetFrom,
      scheduledTo: props.PickupTargetTo ?? null,
      arrivedAt: props.PickupArrival,
      departedAt: props.PickupDeparture ?? null,
      specialInstructions: props.PSpecialInstructions || null,
    },
    delivery: {
      location: formatLocation(props.DCity, props.DState),
      company: props.DCoName || null,
      street: props.DStreet || null,
      street2: props.DStreet2 || null,
      zip: props.DZip || null,
      contact: props.DContact || null,
      phone: props.DPhone || null,
      email: props.DEmail || null,
      scheduledAt: props.DeliveryTargetFrom,
      scheduledTo: props.DeliveryTargetTo ?? null,
      departedAt: props.DeliveryDeparture ?? null,
      specialInstructions: props.DSpecialInstructions || null,
    },
    completedAt: props.DeliveryArrival ?? props.PODcompletion ?? null,
    statusCode: props.Status,
    pieces: props.SPieces ?? null,
    weight: numOrNull(props.SWeight),
    declaredValue: numOrNull(props.SValue),
    codAmount: numOrNull(props.COD),
    codLocation: props.CODLoc || null,
    specialInstructions: props.SpecialInstructions || null,
    packages: props.PackageItems,
    documents: props.Documents,
    podReceivedBy: props.PODname || null,
    podDocumentUrl: props.PODSignature ? `data:image/jpeg;base64,${props.PODSignature}` : null,
    podAvailable: Boolean(props.PODSignature && props.PODSignature.length > 0),
    charges: {
      total: lineItems.reduce((sum, item) => sum + item.amount, 0),
      finalized: lineItems.length > 0,
      lineItems,
    },
  });
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

// Every caller-facing "bulk" lookup in this file (getCompletedOrdersFromXcelerator,
// getAllOrdersFromXceleratorPortal, the reference bulk-search fallback below,
// and searchOrdersByCaller) ultimately asks this same getorders endpoint for
// the same status+date-range row set — a single ClientPortal login plus one
// (often large) JSON response. Without caching, e.g. searching for three
// different callers back to back means three fresh logins and three full
// re-fetches of the same underlying rows. A short TTL cache, keyed by the
// actual query shape (not by what the caller is filtering for afterward),
// turns "N distinct searches" into "1 network round-trip, N in-memory
// filters" as long as they land within the window. In-flight de-duping
// additionally collapses two requests that land in the same tick (e.g. a
// double-click) into one.
const PORTAL_ROWS_CACHE_TTL_MS = 60_000;
const portalRowsCache = new Map<string, { rows: PortalOrderListRow[]; expiresAt: number }>();
const portalRowsInFlight = new Map<string, Promise<PortalOrderListRow[]>>();

function portalRowsCacheKey(
  status: string,
  start: Date,
  end: Date,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
): string {
  // Rounded to the day: every caller of this function passes `new Date()` as
  // `end` (and a `-N days` offset as `start`), which would otherwise mint a
  // unique cache key on every single call and never hit.
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return [status, day(start), day(end), cfg.username ?? ""].join("|");
}

async function fetchPortalOrderRows(
  status: string,
  start: Date,
  end: Date,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
  /**
   * An already-logged-in session to reuse on a cache miss, instead of paying
   * for another portal login (15-90s each in practice). When given, the
   * caller owns recording this attempt in login-performance.ts, since the
   * login it made covers more than this one fetch.
   */
  session?: PortalSession,
): Promise<PortalOrderListRow[]> {
  const cacheKey = portalRowsCacheKey(status, start, end, cfg);
  const cached = portalRowsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  const inFlight = portalRowsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  // Every caller of this function goes through here on a cache miss, so
  // instrumenting this one spot gives login-performance.ts visibility
  // into every login (default and additional alike) for free, regardless
  // of which higher-level function asked for the rows.
  const loginKey = cfg.username ?? "unknown-login";
  const startedAt = Date.now();
  const promise = fetchPortalOrderRowsUncached(status, start, end, cfg, session)
    .then((rows) => {
      if (!session) recordLoginAttempt(loginKey, Date.now() - startedAt, true);
      portalRowsCache.set(cacheKey, { rows, expiresAt: Date.now() + PORTAL_ROWS_CACHE_TTL_MS });
      purgeExpired(portalRowsCache);
      return rows;
    })
    .catch((err) => {
      if (!session) recordLoginAttempt(loginKey, Date.now() - startedAt, false);
      throw err;
    })
    .finally(() => {
      portalRowsInFlight.delete(cacheKey);
    });

  portalRowsInFlight.set(cacheKey, promise);
  return promise;
}

async function fetchPortalOrderRowsUncached(
  status: string,
  start: Date,
  end: Date,
  cfg: ReturnType<typeof xceleratorConfigFromEnv>,
  existingSession?: PortalSession,
): Promise<PortalOrderListRow[]> {
  const session = existingSession ?? (await loginToPortal(cfg));
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

  const rows = result.Data ?? [];
  const allowed = allowedAccountNumbers();
  if (!allowed) return rows;
  return rows.filter((row) => allowed.includes(normalizeAccountNo(row.AccountNo)));
}

// AXIS_ACCOUNT_NO scopes every bulk/list ClientPortal query (via
// fetchPortalOrderRows above) to specific Xcelerator accounts — e.g.
// "FR8T,AJWOR" for two accounts. Confirmed live: getorders' ClientIDs param
// only accepts numeric client ids (passing an account code like "FR8T"
// there 500s), but each row DOES carry its own AccountNo field once you
// look past the narrower PortalOrderListRow subset this file used to type,
// so this filters client-side after the fetch instead. Unset (or blank)
// AXIS_ACCOUNT_NO means "don't scope — show every account", matching this
// function's behavior before the filter existed.
function allowedAccountNumbers(): string[] | null {
  const raw = process.env.AXIS_ACCOUNT_NO?.trim();
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((value) => normalizeAccountNo(value))
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function normalizeAccountNo(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
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
  accountNo: string | null;
  clientRefNo: string | null;
  status: number | null;
  pickupCompany: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCompany: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryArrival: string | null;
  podCompletion: string | null;
  grandTotal: number | null;
};

/**
 * All orders (any status) via the ClientPortal session — the fallback for
 * the raw-debug "GetAllOrders" button when the Axis REST API 401s (auth
 * format still unconfirmed, see axis-api.ts). Uses Status=-1, matching the
 * -1="all" convention ClientIDs already uses on this same getorders
 * endpoint (see TRACKING_ALL_STATUSES_FILTER above).
 *
 * Surfaces every field PortalOrderListRow actually carries. It's still
 * lower-fidelity than the real Axis API — no pickup/delivery target or
 * arrival times, no itemized charge breakdown (see
 * mapPortalOrderListRowToInquiryFallback's comment above) — so those stay
 * absent from OrderInquiry-shaped data, not faked here.
 */
export async function getAllOrdersFromXceleratorPortal(
  start: Date,
  end: Date,
  cfg: XceleratorPortalConfig = xceleratorConfigFromEnv(),
): Promise<PortalOrderRow[]> {
  const rows = await fetchPortalOrderRows(TRACKING_ALL_STATUSES_FILTER, start, end, cfg);

  return rows.map((row) => ({
    orderTrackingId: formatOrderTrackingId(row.OrderTrackingID),
    accountNo: row.AccountNo,
    clientRefNo: row.ClientRefNo,
    status: row.Status,
    pickupCompany: row.PCoName,
    pickupCity: row.PCity,
    pickupState: row.PState,
    deliveryCompany: row.DCoName,
    deliveryCity: row.DCity,
    deliveryState: row.DState,
    deliveryArrival: row.DeliveryArrival,
    podCompletion: row.PODcompletion,
    grandTotal: row.GrandTotal !== null ? parsePortalAmount(row.GrandTotal) : null,
  }));
}

const BULK_SEARCH_LOOKBACK_DAYS = 730;
const TRACKING_ID_PATTERN = /^\d+(\.\d+)?$/;

type CallerLookupHit = {
  order: OrderInquiry;
  /** True when this came from the order-list search: less detail than the order-properties search (no itemized charges, see mapPortalOrderListRowToInquiryFallback). */
  limited: boolean;
};

async function searchOrderUnderSession(
  session: PortalSession,
  referenceNumber: string,
  cfg: XceleratorPortalConfig,
): Promise<CallerLookupHit | null> {
  for (const searchBy of ORDER_LOOKUP_FIELDS) {
    const props = await lookupOrderProperties(session, searchBy, referenceNumber);
    if (props) return { order: mapPortalOrderToInquiry(props), limited: false };
  }

  // getorderproperties has narrower visibility than getorders: confirmed
  // live, it returns Data: [] for real orders getorders finds fine. So when
  // it finds nothing, search the broader all-statuses order list before
  // giving up. Reuses this same session rather than logging in again.
  const end = new Date();
  const start = addDays(end, -BULK_SEARCH_LOOKBACK_DAYS);
  const rows = await fetchPortalOrderRows(TRACKING_ALL_STATUSES_FILTER, start, end, cfg, session);

  const isTrackingId = TRACKING_ID_PATTERN.test(referenceNumber);
  const match = rows.find((row) =>
    isTrackingId
      ? formatOrderTrackingId(row.OrderTrackingID) === referenceNumber
      : (row.ClientRefNo ?? "").trim().toLowerCase() === referenceNumber.toLowerCase(),
  );

  return match ? { order: mapPortalOrderListRowToInquiryFallback(match), limited: true } : null;
}

/**
 * Looks a reference number up under ONE caller, using one portal login for
 * both searches (a login is the slow part: 15-90s each in practice, so
 * paying for a second one just to run the list search would double the
 * cost of every miss). Returns null when this caller has no such order;
 * throws on login/portal failures. Records the outcome in
 * login-performance.ts: a login that works but finds nothing is a success,
 * since the caller itself is healthy.
 */
async function lookupOrderViaCaller(
  referenceNumber: string,
  cfg: XceleratorPortalConfig,
): Promise<CallerLookupHit | null> {
  const search = referenceNumber.trim();
  if (!search) return null;

  const loginKey = cfg.username ?? "unknown-caller";
  const startedAt = Date.now();
  try {
    const session = await loginToPortal(cfg);
    const hit = await searchOrderUnderSession(session, search, cfg);
    recordLoginAttempt(loginKey, Date.now() - startedAt, true);
    return hit;
  } catch (err) {
    recordLoginAttempt(loginKey, Date.now() - startedAt, false);
    throw err;
  }
}

type AcrossCallersResult = {
  winner: { caller: NamedXceleratorCaller; hit: CallerLookupHit } | null;
  /** Callers that couldn't be checked as of when this resolved: login failed, timed out, or skipped by the circuit breaker. A "not found" with entries here means "not found among the callers that could be checked." */
  unchecked: { label: string; message: string }[];
};

/**
 * Checks every caller for a reference number at once and resolves as soon as
 * the answer is settled, without waiting on slower callers it doesn't need
 * (see firstHitInPriorityOrder for the exact rule). Every caller is a peer,
 * with list order as the tie-break when the same reference exists under more
 * than one. Callers still running when this resolves keep going in the
 * background and still feed the row cache and login-performance.ts, same as
 * any other abandoned wait (see withTimeout).
 *
 * Each caller also gets the adaptive layer from login-performance.ts: one
 * that has failed repeatedly is skipped for a cooldown, and each waits only
 * as long as its own recent history suggests.
 */
async function lookupAcrossCallers(
  referenceNumber: string,
  callers: NamedXceleratorCaller[],
): Promise<AcrossCallersResult> {
  const entries: (Promise<CallerLookupHit | null> | Skipped)[] = callers.map((caller) => {
    const loginKey = caller.cfg.username ?? caller.label;
    if (shouldSkipLogin(loginKey)) {
      return { skipped: "skipped, it has failed repeatedly recently (circuit open)" };
    }
    return withTimeout(
      lookupOrderViaCaller(referenceNumber, caller.cfg),
      getAdaptiveTimeoutMs(loginKey),
      caller.label,
    );
  });

  const { winner, failures } = await firstHitInPriorityOrder(entries);
  return {
    winner: winner ? { caller: callers[winner.index], hit: winner.hit } : null,
    unchecked: failures.map((f) => ({ label: callers[f.index].label, message: f.message })),
  };
}

// ---------------------------------------------------------------------------
// Caller search — "who is this on the phone, and what orders are theirs?"
// A CSR searching by caller name/phone/email has no single reference number
// to look up, so this has to scan many orders at once. The naive approach —
// one lookup per candidate order — doesn't work here (there's no candidate
// list yet, that's the whole point), so instead this fetches the same broad
// all-statuses row set the reference bulk-search above uses (and shares its
// cache, via fetchPortalOrderRows/fetchAllAxisOrdersCached below) ONE time
// per source, then filters that in memory. Searching for several different
// callers back to back costs one real network round-trip, not one per
// caller, as long as the searches land within the cache's 60s window.

export type CallerOrderMatch = {
  referenceNumber: string;
  orderTrackingId: string | null;
  customer: string;
  callerName: string | null;
  callerDepartment: string | null;
  callerPhone: string | null;
  callerEmail: string | null;
  /** Which field(s) the search term actually matched, e.g. "phone" or "name, email" — shown in the UI so the CSR can tell why a row came back. */
  matchedOn: string;
  /** Which configured caller (XCELERATOR_CALLER_N_NAME, or its username) this order was found under, or "Axis API" / "mock data" for those sources. Surfaced because a CSR often doesn't know which caller an order shows under. Not related to Xcelerator's AccountNo field. */
  foundViaCaller: string;
};

export type CallerSearchResult = {
  matches: CallerOrderMatch[];
  source: OrderLookupSource;
  /** Set when some callers couldn't be checked (login failed, timed out, or circuit-broken), so a short or empty result isn't mistaken for "nobody by that name." */
  warning?: string;
};

type CallerFields = {
  name: string | null;
  department: string | null;
  phone: string | null;
  email: string | null;
};

const CALLER_SEARCH_LOOKBACK_DAYS = BULK_SEARCH_LOOKBACK_DAYS;
const CALLER_SEARCH_MAX_RESULTS = 25;

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

function callerFieldMatches(term: string, value: string | null | undefined): boolean {
  if (!value) return false;
  if (value.toLowerCase().includes(term)) return true;

  // Phone-shaped search terms (7+ digits) also match against the field's
  // digits alone, so a caller-ID number like "5035550148" finds a caller
  // stored as "(503) 555-0148".
  const termDigits = digitsOnly(term);
  if (termDigits.length >= 7) {
    const valueDigits = digitsOnly(value);
    if (valueDigits.length >= 7 && valueDigits.includes(termDigits)) return true;
  }

  return false;
}

function callerMatchLabel(term: string, fields: CallerFields): string | null {
  const hits: string[] = [];
  if (callerFieldMatches(term, fields.name)) hits.push("name");
  if (callerFieldMatches(term, fields.department)) hits.push("department");
  if (callerFieldMatches(term, fields.phone)) hits.push("phone");
  if (callerFieldMatches(term, fields.email)) hits.push("email");
  return hits.length ? hits.join(", ") : null;
}

function toCallerMatchFromAxis(
  order: TrackOrderV4Response,
  term: string,
  foundViaCaller: string,
): CallerOrderMatch | null {
  const fields: CallerFields = {
    name: order.Caller || null,
    department: order.Department || null,
    phone: order.Phone || null,
    email: order.Email || null,
  };
  const matchedOn = callerMatchLabel(term, fields);
  if (!matchedOn) return null;

  const trackingId = formatOrderTrackingId(order.OrderTrackingId);
  return {
    referenceNumber: order.ClientRefNo || trackingId || "Unknown",
    orderTrackingId: trackingId,
    customer: order.PCoName || order.DCoName || "Unknown",
    callerName: fields.name,
    callerDepartment: fields.department,
    callerPhone: fields.phone,
    callerEmail: fields.email,
    matchedOn,
    foundViaCaller,
  };
}

function toCallerMatchFromPortalRow(
  row: PortalOrderListRow,
  term: string,
  foundViaCaller: string,
): CallerOrderMatch | null {
  const fields: CallerFields = {
    name: row.Caller || null,
    department: row.Department || null,
    phone: row.Phone || null,
    email: row.Email || null,
  };
  const matchedOn = callerMatchLabel(term, fields);
  if (!matchedOn) return null;

  const trackingId = formatOrderTrackingId(row.OrderTrackingID);
  return {
    referenceNumber: row.ClientRefNo || trackingId || "Unknown",
    orderTrackingId: trackingId,
    customer: row.PCoName || row.DCoName || row.CompanyName || "Unknown",
    callerName: fields.name,
    callerDepartment: fields.department,
    callerPhone: fields.phone,
    callerEmail: fields.email,
    matchedOn,
    foundViaCaller,
  };
}

function toCallerMatchFromInquiry(order: OrderInquiry, term: string): CallerOrderMatch | null {
  const matchedOn = callerMatchLabel(term, order.caller);
  if (!matchedOn) return null;

  return {
    referenceNumber: order.referenceNumber,
    orderTrackingId: null,
    customer: order.customer,
    callerName: order.caller.name,
    callerDepartment: order.caller.department,
    callerPhone: order.caller.phone,
    callerEmail: order.caller.email,
    matchedOn,
    foundViaCaller: "mock data",
  };
}

// Mirrors fetchPortalOrderRows' cache (see its header comment): the Axis
// GetAllOrders response for a given date window is cached for 60s and
// in-flight requests are de-duped, so back-to-back caller searches (and any
// future feature that wants "all orders in a window") share one fetch
// instead of each paying for their own.
const AXIS_ALL_ORDERS_CACHE_TTL_MS = 60_000;
const axisAllOrdersCache = new Map<string, { orders: TrackOrderV4Response[]; expiresAt: number }>();
const axisAllOrdersInFlight = new Map<string, Promise<TrackOrderV4Response[]>>();

// Both caches above are keyed by a day-rounded date window, so a new key is
// minted every day for every caller, and nothing ever removed the expired
// ones: a server left running for weeks would keep a full order list per
// day per caller in memory. Dropped whenever a fresh entry is stored.
function purgeExpired<V extends { expiresAt: number }>(cache: Map<string, V>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

export type CacheEntryInfo = { key: string; count: number; ageSec: number; expiresInSec: number };

/** Read-only view of the lookup caches, for the /debug page. */
export function debugCacheStats(): {
  ttlSeconds: number;
  portalRows: CacheEntryInfo[];
  portalRowsInFlight: number;
  axisAllOrders: CacheEntryInfo[];
  axisAllOrdersInFlight: number;
} {
  const now = Date.now();
  const describe = (key: string, count: number, expiresAt: number, ttlMs: number): CacheEntryInfo => ({
    key,
    count,
    ageSec: Math.max(0, Math.round((now - (expiresAt - ttlMs)) / 1000)),
    expiresInSec: Math.round((expiresAt - now) / 1000),
  });

  return {
    ttlSeconds: PORTAL_ROWS_CACHE_TTL_MS / 1000,
    portalRows: [...portalRowsCache].map(([key, v]) =>
      describe(key, v.rows.length, v.expiresAt, PORTAL_ROWS_CACHE_TTL_MS),
    ),
    portalRowsInFlight: portalRowsInFlight.size,
    axisAllOrders: [...axisAllOrdersCache].map(([key, v]) =>
      describe(key, v.orders.length, v.expiresAt, AXIS_ALL_ORDERS_CACHE_TTL_MS),
    ),
    axisAllOrdersInFlight: axisAllOrdersInFlight.size,
  };
}

/** Empties both lookup caches so the next search re-fetches (in-flight requests are left alone). */
export function clearLookupCaches(): void {
  portalRowsCache.clear();
  axisAllOrdersCache.clear();
}

function axisAllOrdersCacheKey(start: Date, end: Date): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return `${day(start)}|${day(end)}`;
}

async function fetchAllAxisOrdersCached(start: Date, end: Date): Promise<TrackOrderV4Response[]> {
  const key = axisAllOrdersCacheKey(start, end);
  const cached = axisAllOrdersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.orders;

  const inFlight = axisAllOrdersInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = getAllOrdersFromAxisRaw(start, end)
    .then((orders) => {
      axisAllOrdersCache.set(key, { orders, expiresAt: Date.now() + AXIS_ALL_ORDERS_CACHE_TTL_MS });
      purgeExpired(axisAllOrdersCache);
      return orders;
    })
    .finally(() => {
      axisAllOrdersInFlight.delete(key);
    });

  axisAllOrdersInFlight.set(key, promise);
  return promise;
}

/**
 * Finds orders whose caller name, department, phone, or email contains
 * `search` (case-insensitive; phone numbers also match on digits alone).
 * Same Axis-first, ClientPortal-fallback, mock-last pattern as
 * getOrderByReferenceNumberDetailed above, but — unlike that function — both
 * live paths here go through a 60s cache (fetchAllAxisOrdersCached /
 * fetchPortalOrderRows) shared with every other bulk read in this file, so
 * this function alone never costs more than one real network round-trip per
 * source per minute, no matter how many different callers get searched for
 * in that window.
 */
export async function searchOrdersByCaller(search: string): Promise<CallerSearchResult> {
  const term = search.trim().toLowerCase();
  if (!term) return { matches: [], source: "mock" };

  const end = new Date();
  const start = addDays(end, -CALLER_SEARCH_LOOKBACK_DAYS);

  if (isAxisApiConfigured() && !shouldSkipLogin("axis")) {
    const axisStartedAt = Date.now();
    try {
      const orders = await fetchAllAxisOrdersCached(start, end);
      recordLoginAttempt("axis", Date.now() - axisStartedAt, true);
      const matches: CallerOrderMatch[] = [];
      for (const order of orders) {
        const match = toCallerMatchFromAxis(order, term, "Axis API");
        if (match) matches.push(match);
        if (matches.length >= CALLER_SEARCH_MAX_RESULTS) break;
      }
      return { matches, source: "axis" };
    } catch (err) {
      recordLoginAttempt("axis", Date.now() - axisStartedAt, false);
      console.warn(
        "Axis caller search failed, falling back to ClientPortal:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const callers = xceleratorCallersFromEnv();
  if (callers.length > 0) {
    // Check every configured caller: a CSR searching by caller often doesn't
    // know which one an order shows under. Each needs its own login+fetch,
    // and a fresh login to this portal measured 15-90s in practice, so they
    // run concurrently (waiting on the slowest one, not the sum of all)
    // instead of one after another. Every caller's row set is still
    // independently cached (see fetchPortalOrderRows), so repeat searches
    // stay cheap regardless.
    //
    // Adaptive layer (login-performance.ts): a caller that has failed
    // repeatedly gets skipped outright for a cooldown instead of eating a
    // full attempt, and each waits only as long as its own recent history
    // suggests, not one fixed guess for all of them.
    const settled = await Promise.allSettled(
      callers.map((caller) => {
        const loginKey = caller.cfg.username ?? caller.label;
        if (shouldSkipLogin(loginKey)) {
          return Promise.reject(new Error("skipped, it has failed repeatedly recently (circuit open)"));
        }
        return withTimeout(
          fetchPortalOrderRows(TRACKING_ALL_STATUSES_FILTER, start, end, caller.cfg),
          getAdaptiveTimeoutMs(loginKey),
          caller.label,
        );
      }),
    );

    const matches: CallerOrderMatch[] = [];
    const unchecked: string[] = [];
    settled.forEach((result, i) => {
      const caller = callers[i];
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`Caller search via Xcelerator caller "${caller.label}" failed, skipping it:`, message);
        unchecked.push(`Caller "${caller.label}" could not be checked (${message}).`);
        return;
      }
      for (const row of result.value) {
        if (matches.length >= CALLER_SEARCH_MAX_RESULTS) break;
        const match = toCallerMatchFromPortalRow(row, term, caller.label);
        if (match) matches.push(match);
      }
    });
    return {
      matches: matches.slice(0, CALLER_SEARCH_MAX_RESULTS),
      source: "portal",
      warning: unchecked.length > 0 ? unchecked.join(" ") : undefined,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));
  const matches: CallerOrderMatch[] = [];
  for (const order of Object.values(MOCK_ORDERS)) {
    const match = toCallerMatchFromInquiry(order, term);
    if (match) matches.push(match);
    if (matches.length >= CALLER_SEARCH_MAX_RESULTS) break;
  }
  return { matches, source: "mock" };
}

export function listSampleReferenceNumbers(): string[] {
  return Object.keys(MOCK_ORDERS);
}
