// Real Axis REST API client (the one described in the Xcelerator "AXIS" FAQ),
// as opposed to src/lib/xcelerator-portal.ts, which mimics the ClientPortal's
// own internal AJAX calls behind a session cookie.
//
// Endpoint list, parameter names, and response shape below were pulled live
// from this deployment's own Swagger/OpenAPI document (Swagger 2.0), fetched
// from:
//   https://skylinecourierlogistics.com/Xcelerator/Axis/Swagger/docs/1
// (the page at .../axis/swagger is just the Swagger UI shell; that URL is the
// actual spec it loads — same data a browser would show under "Axis Help").
//
// AUTH IS UNCONFIRMED — CONFIRMED WRONG, ACTUALLY. The spec's
// securityDefinitions entry is:
//   { "Token": { "type": "apiKey", "in": "header", "name": "Authorization",
//                "description": "Add your Axis Bearer token here." } }
// which only tells us the header name (Authorization), not how to derive the
// value from a caller's AXIS username/password. Nothing in the spec exposes a
// login/token endpoint. `Basic base64(username:password)` (the fallback
// below) was tried live against this deployment and got HTTP 401
// {"Message":"Authorization has been denied for this request."} — the
// generic ASP.NET "no auth scheme matched" rejection, which suggests the
// server isn't parsing a Basic-auth header at all, not just rejecting bad
// credentials. Two real leads to chase, in order of likelihood:
//   1. This is an OWIN/ASP.NET Identity password-grant OAuth2 setup: POST
//      username+password as a form body to a /token endpoint (commonly at
//      the site root or under the Axis base path) and get back a JSON
//      { access_token, token_type } to send as "Bearer <access_token>".
//      Very common pairing with a bare Swashbuckle "apiKey" Authorization
//      header description like the one above.
//   2. The AXIS package's Web API Authorization Guide + "Hello World" C#
//      sample (downloadable from inside Xcelerator — see the FAQ) documents
//      the real mechanism directly; that's the authoritative source once
//      available.
// Until one of these is confirmed, AXIS_API_TOKEN is the escape hatch: paste
// the exact header value once you have it (e.g. "Bearer xxxxx") and it wins
// over the Basic-auth guess below. getOrderByReferenceNumber() in
// xcelerator.ts tries this client first and falls back to the ClientPortal
// session lookup on any failure, so a wrong guess here degrades gracefully
// instead of breaking order lookup.
//
// 2026-09-02 re-check against the live spec: the v4 order documents shape
// was wrong. GetOrders/GetOrderByReference's OrderDocuments items
// (definitions.OrderDocumentV4) carry DocumentGuid/Name/Details/FileFormat/
// Location — there is NO DocumentBinary field on v4. That field only exists
// on the older, deprecated /v1/Document/GetDocument response
// (definitions.OrderDocument), which this client doesn't call. So the old
// podDocumentUrl() below always returned null against a real v4 response,
// even when HasPODsignature was true. The documented way to pull actual
// bytes back out of v4 is a second call, GET /v4/Order/GetOrderImage
// (imageType=PODsignature for the captured signature, or
// imageType=DocumentGuid&documentGuid=<guid> for one of the OrderDocuments
// attachments) — see fetchAxisOrderImage()/resolvePodDocumentUrl() below.
// That endpoint's 200 response is left as a bare "object" in the spec
// (unconfirmed against a live populated order), so it's parsed defensively
// and never throws.
//
// Server-only: reads credentials from the environment and must never run in
// the browser.

import type { CompletedOrderSummary, OrderInquiry } from "./xcelerator";

export type AxisApiConfig = {
  /** Base Axis API URL, no trailing slash. e.g. https://host/Xcelerator/Axis */
  baseUrl: string;
  username?: string;
  password?: string;
  /** Verbatim Authorization header value, overriding the Basic-auth guess. */
  token?: string;
};

const DEFAULT_AXIS_API_BASE_URL = "https://skylinecourierlogistics.com/Xcelerator/Axis";

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function axisApiConfigFromEnv(): AxisApiConfig {
  const explicitBase = envValue("AXIS_API_BASE_URL");
  const portalBase = envValue("AXIS_PORTAL_BASE_URL") || envValue("XCELERATOR_PORTAL_BASE_URL");
  const baseUrl = (
    explicitBase ||
    (portalBase ? `${portalBase.replace(/\/+$/, "")}/Axis` : DEFAULT_AXIS_API_BASE_URL)
  ).replace(/\/+$/, "");

  return {
    baseUrl,
    username: envValue("AXIS_USERNAME"),
    password: envValue("AXIS_PASSWORD"),
    token: envValue("AXIS_API_TOKEN"),
  };
}

export function isAxisApiConfigured(): boolean {
  const cfg = axisApiConfigFromEnv();
  return Boolean(cfg.token || (cfg.username && cfg.password));
}

export class AxisApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AxisApiError";
    this.status = status;
  }
}

function base64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

function authHeaderValue(cfg: AxisApiConfig): string {
  if (cfg.token) return cfg.token;
  if (cfg.username && cfg.password) {
    // Best-guess default — see the file header comment. Override with
    // AXIS_API_TOKEN once the Web API Authorization Guide confirms the
    // real format (may need a "Bearer " prefix instead, a raw token issued
    // some other way, etc).
    return `Basic ${base64(`${cfg.username}:${cfg.password}`)}`;
  }
  throw new AxisApiError(
    "Axis API is not configured. Set AXIS_API_TOKEN, or AXIS_USERNAME + AXIS_PASSWORD.",
  );
}

async function axisGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  cfg: AxisApiConfig = axisApiConfigFromEnv(),
): Promise<T> {
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: authHeaderValue(cfg),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AxisApiError(
      `Axis API ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AxisApiError(`Axis API ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// --- /v4/Order response shape (subset of TrackOrderV4Response we use) ------

// Matches definitions.OrderDocumentV4 in the live spec exactly — no
// DocumentBinary field here (see the file header note above).
type AxisOrderDocument = {
  DocumentGuid?: string | null;
  Name?: string | null;
  Details?: string | null;
  FileFormat?: string | null;
  Location?: string | null;
};

// Matches definitions.OrderPackageItemV4 in the live spec — per-package
// weight/dimensions/reference when the account is set to use individual
// package items (see OrderInquiry.shipment.packages in xcelerator.ts).
type AxisOrderPackageItem = {
  PackageName?: string | null;
  RefNo?: string | null;
  Weight?: number | null;
  Length?: number | null;
  Width?: number | null;
  Height?: number | null;
};

// Confirmed against this deployment's live Swagger/OpenAPI document
// (2026-09-09 re-check — see the file header note) for definitions.
// TrackOrderV4Response. Still a subset of that definition — everything
// below is real, but the full response also has scheduling/notification/
// GPS/memo fields this client has no use for and deliberately omits.
export type TrackOrderV4Response = {
  OrderTrackingId: number;
  oDate?: string | null;
  Status?: string | null;
  OrderType?: string | null;
  AccountNo?: string | null;
  Caller?: string | null;
  Department?: string | null;
  Phone?: string | null;
  Email?: string | null;
  SpecInstr?: string | null;
  ClientRefNo?: string | null;
  ClientRefNo2?: string | null;
  ClientRefNo3?: string | null;
  ClientRefNo4?: string | null;
  ServiceName?: string | null;
  VehicleName?: string | null;
  RouteNo?: string | null;
  DriverNo?: string | null;
  DriverFirstName?: string | null;
  DriverLastName?: string | null;
  PCoName?: string | null;
  PContact?: string | null;
  PPhone?: string | null;
  PEmail?: string | null;
  PStreet?: string | null;
  PStreet2?: string | null;
  PCity?: string | null;
  PState?: string | null;
  PZip?: string | null;
  PLocRefNo?: string | null;
  PSpecInstr?: string | null;
  DCoName?: string | null;
  DContact?: string | null;
  DPhone?: string | null;
  DEmail?: string | null;
  DStreet?: string | null;
  DStreet2?: string | null;
  DCity?: string | null;
  DState?: string | null;
  DZip?: string | null;
  DLocRefNo?: string | null;
  DSpecInstr?: string | null;
  sWeight?: number | null;
  sValue?: number | null;
  COD?: number | null;
  CODloc?: string | null;
  PickupTargetFrom?: string | null;
  PickupTargetTo?: string | null;
  PickupArrival?: string | null;
  PickupDeparture?: string | null;
  DeliveryTargetFrom?: string | null;
  DeliveryTargetTo?: string | null;
  DeliveryArrival?: string | null;
  DeliveryDeparture?: string | null;
  PODcompletion?: string | null;
  HasPODsignature?: boolean | null;
  PODname?: string | null;
  ThirdPartyCarrierId?: number | null;
  ThirdPartyTrackingRefNo?: string | null;
  OrderPackageItems?: AxisOrderPackageItem[] | null;
  GrandTotal?: number | null;
  OrderCharge?: number | null;
  MiscCharge?: number | null;
  HourlyCharge?: number | null;
  PackageCharge?: number | null;
  WeightCharge?: number | null;
  DeclaredValueCharge?: number | null;
  CODCharge?: number | null;
  AfterHoursCharge?: number | null;
  WaitTimeCharge?: number | null;
  StopOffCharge?: number | null;
  TollCharge?: number | null;
  OtherChg1?: number | null;
  OtherChg2?: number | null;
  OrderDocuments?: AxisOrderDocument[] | null;
};

const CLIENT_REF_FIELDS = ["ClientRefNo", "ClientRefNo2", "ClientRefNo3", "ClientRefNo4"] as const;

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  PDF: "application/pdf",
  JPEG: "image/jpeg",
  BMP: "image/bmp",
  GIF: "image/gif",
  PNG: "image/png",
};

function formatOrderTrackingId(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : String(value);
}

function formatLocation(city?: string | null, state?: string | null): string {
  return [city, state].filter(Boolean).join(", ");
}

// GET /v4/Order/GetOrderImage — the documented way to pull actual binary
// data out of Axis v4: imageType=PODsignature for the captured
// proof-of-delivery signature itself (what HasPODsignature/PODname
// describe), or imageType=DocumentGuid + documentGuid=<guid> for one of the
// free-form OrderDocuments attachments. The spec leaves the 200 response
// schema as a bare "object" (unconfirmed against a live populated order),
// so this parses defensively — a bare base64 JSON string, or an object
// wrapping it under one of a few conventional key names — and never
// throws, so a wrong guess here just means a missing POD link, not a
// broken order lookup.
async function fetchAxisOrderImage(
  orderTrackingId: number,
  imageType: "PODsignature" | "DocumentGuid",
  cfg: AxisApiConfig,
  documentGuid?: string | null,
): Promise<string | null> {
  try {
    const raw = await axisGet<unknown>(
      "/v4/Order/GetOrderImage",
      { orderTrackingId, imageType, documentGuid: documentGuid ?? undefined },
      cfg,
    );
    if (typeof raw === "string") return raw || null;
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const candidate = obj.Image ?? obj.ImageData ?? obj.Data ?? obj.Base64 ?? obj.DocumentBinary;
      if (typeof candidate === "string" && candidate) return candidate;
    }
    return null;
  } catch (err) {
    console.warn(
      `Axis GetOrderImage (${imageType}) failed for order ${orderTrackingId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function resolvePodDocumentUrl(
  order: TrackOrderV4Response,
  cfg: AxisApiConfig,
): Promise<string | null> {
  const podDoc = (order.OrderDocuments ?? []).find((d) =>
    /pod|proof of delivery/i.test(d.Name ?? d.Details ?? ""),
  );

  if (podDoc?.DocumentGuid) {
    const base64Data = await fetchAxisOrderImage(
      order.OrderTrackingId,
      "DocumentGuid",
      cfg,
      podDoc.DocumentGuid,
    );
    if (base64Data) {
      const mime =
        DOCUMENT_MIME_TYPES[(podDoc.FileFormat ?? "").toUpperCase()] ?? "application/octet-stream";
      return `data:${mime};base64,${base64Data}`;
    }
  }

  if (order.HasPODsignature) {
    const base64Data = await fetchAxisOrderImage(order.OrderTrackingId, "PODsignature", cfg);
    if (base64Data) return `data:image/jpeg;base64,${base64Data}`;
  }

  return null;
}

export function chargeLineItems(order: TrackOrderV4Response): { label: string; amount: number }[] {
  const candidates: [string, number | null | undefined][] = [
    ["Base charge", order.OrderCharge],
    ["Package charge", order.PackageCharge],
    ["Weight charge", order.WeightCharge],
    ["Hourly charge", order.HourlyCharge],
    ["Declared value", order.DeclaredValueCharge],
    ["COD charge", order.CODCharge],
    ["After hours", order.AfterHoursCharge],
    ["Wait time", order.WaitTimeCharge],
    ["Stop off", order.StopOffCharge],
    ["Toll", order.TollCharge],
    ["Other charge 1", order.OtherChg1],
    ["Other charge 2", order.OtherChg2],
    ["Misc.", order.MiscCharge],
  ];
  return candidates
    .filter(([, amount]) => typeof amount === "number" && amount !== 0)
    .map(([label, amount]) => ({ label, amount: amount as number }));
}

function mapAxisPackageItems(
  items: AxisOrderPackageItem[] | null | undefined,
): { name: string | null; refNo: string | null; weight: number | null; length: number | null; width: number | null; height: number | null }[] {
  return (items ?? []).map((item) => ({
    name: item.PackageName ?? null,
    refNo: item.RefNo ?? null,
    weight: item.Weight ?? null,
    length: item.Length ?? null,
    width: item.Width ?? null,
    height: item.Height ?? null,
  }));
}

async function mapAxisOrderToInquiry(
  order: TrackOrderV4Response,
  cfg: AxisApiConfig,
): Promise<OrderInquiry> {
  const completedAt = order.DeliveryArrival ?? order.PODcompletion ?? null;
  const delivered = Boolean(completedAt);
  const lineItems = chargeLineItems(order);
  const trackingId = formatOrderTrackingId(order.OrderTrackingId);

  return {
    referenceNumber: order.ClientRefNo || trackingId,
    referenceNumber2: order.ClientRefNo2 || null,
    referenceNumber3: order.ClientRefNo3 || null,
    referenceNumber4: order.ClientRefNo4 || null,
    // Axis's TrackOrderV4Response has no InvoiceNo field — only the
    // ClientPortal endpoints do (see xcelerator.ts).
    invoiceNumber: null,
    customer: order.PCoName ?? order.DCoName ?? "Unknown",
    carrier: "Skyline Courier & Logistics",
    status: delivered ? "delivered" : order.PickupArrival ? "in_transit" : "pending_pickup",
    orderType: order.OrderType ?? null,
    service: order.ServiceName ?? null,
    vehicle: order.VehicleName ?? null,
    caller: {
      name: order.Caller || null,
      department: order.Department || null,
      phone: order.Phone || null,
      email: order.Email || null,
    },
    pickup: {
      location: formatLocation(order.PCity, order.PState),
      company: order.PCoName ?? null,
      street: order.PStreet ?? null,
      street2: order.PStreet2 ?? null,
      zip: order.PZip ?? null,
      contact: order.PContact ?? null,
      phone: order.PPhone ?? null,
      email: order.PEmail ?? null,
      scheduledAt: order.PickupTargetFrom ?? "",
      scheduledTo: order.PickupTargetTo ?? null,
      arrived: Boolean(order.PickupArrival),
      arrivedAt: order.PickupArrival ?? null,
      departedAt: order.PickupDeparture ?? null,
      specialInstructions: order.PSpecInstr || null,
    },
    delivery: {
      location: formatLocation(order.DCity, order.DState),
      company: order.DCoName ?? null,
      street: order.DStreet ?? null,
      street2: order.DStreet2 ?? null,
      zip: order.DZip ?? null,
      contact: order.DContact ?? null,
      phone: order.DPhone ?? null,
      email: order.DEmail ?? null,
      scheduledAt: order.DeliveryTargetFrom ?? "",
      scheduledTo: order.DeliveryTargetTo ?? null,
      delivered,
      deliveredAt: completedAt,
      departedAt: order.DeliveryDeparture ?? null,
      specialInstructions: order.DSpecInstr || null,
    },
    shipment: {
      pieces: order.OrderPackageItems?.length ?? null,
      weight: order.sWeight ?? null,
      declaredValue: order.sValue ?? null,
      packages: mapAxisPackageItems(order.OrderPackageItems),
    },
    cod: {
      amount: order.COD ?? null,
      location: order.CODloc || null,
    },
    thirdPartyTrackingRefNo: order.ThirdPartyTrackingRefNo || null,
    specialInstructions: order.SpecInstr || null,
    pod: {
      available: Boolean(order.HasPODsignature),
      receivedBy: order.PODname || null,
      documentUrl: await resolvePodDocumentUrl(order, cfg),
    },
    charges: {
      currency: "USD",
      total: typeof order.GrandTotal === "number" ? order.GrandTotal : 0,
      finalized: typeof order.GrandTotal === "number" && order.GrandTotal > 0,
      lineItems,
    },
    documents: (order.OrderDocuments ?? []).map((doc) => ({
      name: doc.Name ?? doc.Details ?? null,
      fileFormat: doc.FileFormat ?? null,
    })),
  };
}

// The portal displays OrderTrackingId as a fractional number (e.g.
// "105.081826", see formatOrderTrackingId above) and CSRs paste that in just
// as often as a ClientRefNo — the UI's placeholder text says as much. Axis
// only matches OrderTrackingId through GetOrders, not GetOrderByReference, so
// treat a numeric-looking input as a tracking id first.
const TRACKING_ID_PATTERN = /^\d+(\.\d+)?$/;

async function getOrderByTrackingIdFromAxis(
  trackingId: string,
  cfg: AxisApiConfig,
): Promise<OrderInquiry | null> {
  const results = await axisGet<TrackOrderV4Response[]>(
    "/v4/Order/GetOrders",
    { orderTrackingId: trackingId, includeDocuments: true, includePackages: true },
    cfg,
  );
  const match = results?.find((o) => Boolean(o.OrderTrackingId));
  return match ? mapAxisOrderToInquiry(match, cfg) : null;
}

/**
 * Look up an order via the real Axis REST API. A numeric-looking input (e.g.
 * "105.081826") is tried as an OrderTrackingId first (GET /v4/Order/GetOrders);
 * otherwise, or if that finds nothing, it's tried against each ClientRefNo
 * field in turn (GET /v4/Order/GetOrderByReference — Axis only matches one
 * field per call). Throws AxisApiError on network/auth/HTTP failures; returns
 * null (not an error) when nothing matches. Any thrown error propagates
 * straight out — xcelerator.ts's caller catches it and falls back to the
 * ClientPortal session lookup, so e.g. an auth failure on the first attempt
 * doesn't retry the remaining ones with the same bad credential.
 */
export async function getOrderByReferenceFromAxis(
  referenceNumber: string,
  cfg: AxisApiConfig = axisApiConfigFromEnv(),
): Promise<OrderInquiry | null> {
  const value = referenceNumber.trim();
  if (!value) return null;

  if (TRACKING_ID_PATTERN.test(value)) {
    const byTrackingId = await getOrderByTrackingIdFromAxis(value, cfg);
    if (byTrackingId) return byTrackingId;
  }

  for (const field of CLIENT_REF_FIELDS) {
    const results = await axisGet<TrackOrderV4Response[]>(
      "/v4/Order/GetOrderByReference",
      { clientRefNo: field, value, includeDocuments: true, includePackages: true },
      cfg,
    );
    const match = results?.find((o) => Boolean(o.OrderTrackingId));
    if (match) return mapAxisOrderToInquiry(match, cfg);
  }

  return null;
}

// --- GET /v4/Order/GetAllOrders --------------------------------------------
//
// fromDate/toDate are required and always filtered against one date column,
// picked via queryDate (oDate | CreationUTC | POD_Completion |
// PODRT_Completion | PickupDeparture — no stated default in the spec, so it
// is always passed explicitly here). GetAllOrders returns every order type
// in range, not just completed ones, so completedOrders below both asks for
// queryDate=POD_Completion (Axis filters server-side on the same timestamp
// PODcompletion reports back) and drops any row that still comes back
// without one. The response is a bare array with no total-count wrapper —
// unlike the ClientPortal's getorders endpoint — so paging stops once a
// page comes back shorter than the page size requested.

const AXIS_ALL_ORDERS_PAGE_SIZE = 500; // documented max for recordsPerPage
const AXIS_ALL_ORDERS_MAX_PAGES = 50; // safety cap against a runaway loop

function toAxisDateTimeParam(date: Date): string {
  return date.toISOString();
}

function mapAxisOrderToCompletedSummary(order: TrackOrderV4Response): CompletedOrderSummary | null {
  const completedAt = order.DeliveryArrival ?? order.PODcompletion ?? null;
  if (!completedAt) return null;
  const trackingId = formatOrderTrackingId(order.OrderTrackingId);

  return {
    referenceNumber: order.ClientRefNo || trackingId,
    orderTrackingId: trackingId,
    customer: order.PCoName ?? order.DCoName ?? "Unknown",
    carrier: "Skyline Courier & Logistics",
    pickupLocation: formatLocation(order.PCity, order.PState),
    deliveryLocation: formatLocation(order.DCity, order.DState),
    completedAt,
    podAvailable: Boolean(order.HasPODsignature),
    charges: {
      currency: "USD",
      total: typeof order.GrandTotal === "number" ? order.GrandTotal : 0,
      finalized: typeof order.GrandTotal === "number" && order.GrandTotal > 0,
    },
  };
}

/**
 * List completed orders in [start, end] via the real Axis REST API (GET
 * /v4/Order/GetAllOrders, queryDate=POD_Completion). Pages through
 * recordsPerPage=500 chunks — the documented max — until a short page
 * signals the end. Deliberately skips includeDocuments/GetOrderImage (see
 * resolvePodDocumentUrl): a bulk date-range pull can be hundreds of orders,
 * CompletedOrderSummary only needs the podAvailable flag (not a document
 * URL), and firing one extra HTTP request per order for data nothing reads
 * would make this endpoint needlessly slow.
 */
export async function getCompletedOrdersFromAxis(
  start: Date,
  end: Date,
  cfg: AxisApiConfig = axisApiConfigFromEnv(),
): Promise<CompletedOrderSummary[]> {
  const summaries: CompletedOrderSummary[] = [];

  for (let pageNumber = 1; pageNumber <= AXIS_ALL_ORDERS_MAX_PAGES; pageNumber++) {
    const page = await axisGet<TrackOrderV4Response[]>(
      "/v4/Order/GetAllOrders",
      {
        fromDate: toAxisDateTimeParam(start),
        toDate: toAxisDateTimeParam(end),
        queryDate: "POD_Completion",
        pageNumber,
        recordsPerPage: AXIS_ALL_ORDERS_PAGE_SIZE,
      },
      cfg,
    );
    if (!page?.length) break;
    for (const order of page) {
      const summary = mapAxisOrderToCompletedSummary(order);
      if (summary) summaries.push(summary);
    }
    if (page.length < AXIS_ALL_ORDERS_PAGE_SIZE) break;
  }

  return summaries;
}

/**
 * Raw debug entry point: calls GET /v4/Order/GetAllOrders directly and
 * returns exactly what Axis sends back for [start, end] — every order
 * status, no queryDate override (so Axis's own default date column
 * applies), no mapping to OrderInquiry/CompletedOrderSummary, and
 * deliberately NO ClientPortal fallback. Unlike getCompletedOrdersFromAxis
 * above, any HTTP/auth failure here propagates as AxisApiError straight to
 * the caller — the point is to see Axis's real response (or real error),
 * not a masked one.
 */
export async function getAllOrdersFromAxisRaw(
  start: Date,
  end: Date,
  cfg: AxisApiConfig = axisApiConfigFromEnv(),
): Promise<TrackOrderV4Response[]> {
  const orders: TrackOrderV4Response[] = [];

  for (let pageNumber = 1; pageNumber <= AXIS_ALL_ORDERS_MAX_PAGES; pageNumber++) {
    const page = await axisGet<TrackOrderV4Response[]>(
      "/v4/Order/GetAllOrders",
      {
        fromDate: toAxisDateTimeParam(start),
        toDate: toAxisDateTimeParam(end),
        pageNumber,
        recordsPerPage: AXIS_ALL_ORDERS_PAGE_SIZE,
      },
      cfg,
    );
    if (!page?.length) break;
    orders.push(...page);
    if (page.length < AXIS_ALL_ORDERS_PAGE_SIZE) break;
  }

  return orders;
}
