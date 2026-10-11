// Documents attached to an Xcelerator order, through the ClientPortal's own
// order-window endpoints (MainFrame.js: fillDocumentDropdown, attachDocument,
// runDeleteDocument), signed in as one of the XCELERATOR_CALLER_N_* logins.
// Server-only.
//
//   list:   GET  .../api/trackingOnline/getDocuments?_p_OrderTrackingID=<id>&_p_Loc=
//           -> { Data: [{ Value: <document id>, Text: <file name> }] }, Value 0 = "[Select Document]"
//   attach: POST .../api/trackingOnline/attachDocument?_p_OrderTrackingID=<id>&_p_Location=
//           multipart field "FileUpload" -> 1 on success, else an error message
//
// The portal accepts PDF, BMP, GIF, JPG and PNG files up to 25 MB. Documents
// attached here show in the order's document list in the ClientPortal, where
// the customer's own logins can see them too.

import {
  loginToPortal,
  portalJson,
  xceleratorCallersFromEnv,
  XceleratorPortalError,
  type NamedXceleratorCaller,
  type PortalSession,
} from "./xcelerator-portal";

export type OrderDocumentEntry = { id: number; name: string };

/** Largest file the portal accepts (its upload widget's limit). */
export const MAX_ORDER_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** File types the portal accepts, by content type. */
export const ORDER_DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

const TRACKING_ID = /^\d+\.\d{6}$/;

export class OrderDocumentError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function findCaller(label: string): NamedXceleratorCaller {
  const want = label.trim().toLowerCase();
  const caller = xceleratorCallersFromEnv().find(
    (c) => c.label.toLowerCase() === want || c.cfg.username?.toLowerCase() === want,
  );
  if (!caller) throw new OrderDocumentError(`No Xcelerator login named "${label}" is configured.`, 400);
  return caller;
}

function checkTrackingId(orderTrackingId: string): string {
  const id = orderTrackingId.trim();
  if (!TRACKING_ID.test(id)) throw new OrderDocumentError(`"${orderTrackingId}" isn't an Xcelerator order id (like 111.040926).`, 400);
  return id;
}

// One signed-in session per caller, reused for 10 minutes.
const SESSION_TTL_MS = 10 * 60_000;
const sessions = new Map<string, { session: Promise<PortalSession>; expiresAt: number }>();

function session(caller: NamedXceleratorCaller, fresh = false): Promise<PortalSession> {
  const cached = sessions.get(caller.label);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.session;
  const pending = loginToPortal(caller.cfg);
  sessions.set(caller.label, { session: pending, expiresAt: Date.now() + SESSION_TTL_MS });
  pending.catch(() => sessions.delete(caller.label));
  return pending;
}

type DocumentListResponse = { Data?: { Value: number; Text: string | null }[] | null; Error?: string | null };

async function fetchList(s: PortalSession, id: string): Promise<OrderDocumentEntry[]> {
  const res = await portalJson<DocumentListResponse>(
    s,
    `/ClientPortal/ClientPortal/api/trackingOnline/getDocuments?_p_OrderTrackingID=${id}&_p_Loc=`,
  );
  if (res.Error) throw new OrderDocumentError(`Xcelerator couldn't list the order's documents: ${res.Error}`);
  return (res.Data ?? []).filter((d) => d.Value > 0).map((d) => ({ id: d.Value, name: (d.Text ?? "").trim() }));
}

/**
 * Lists with the cached session, signing in again once if it has ended (the
 * portal answers 401, or a login page instead of JSON). Reading twice is
 * harmless, so this is the one call allowed to retry.
 */
async function listWithRetry(caller: NamedXceleratorCaller, id: string): Promise<{ s: PortalSession; documents: OrderDocumentEntry[] }> {
  try {
    const s = await session(caller);
    return { s, documents: await fetchList(s, id) };
  } catch (err) {
    if (!(err instanceof XceleratorPortalError)) throw err;
    const s = await session(caller, true);
    return { s, documents: await fetchList(s, id) };
  }
}

/** The documents attached to an order, as `callerLabel` sees them. */
export async function listOrderDocuments(callerLabel: string, orderTrackingId: string): Promise<OrderDocumentEntry[]> {
  return (await listWithRetry(findCaller(callerLabel), checkTrackingId(orderTrackingId))).documents;
}

/**
 * Attaches a file to an order. The list call just before it confirms the
 * session works, so the upload itself is sent exactly once and never
 * retried (a retry after an unclear failure could attach it twice). Returns
 * the order's documents afterwards and the one that was added.
 */
export async function attachDocumentToOrder(params: {
  callerLabel: string;
  orderTrackingId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}): Promise<{ added: OrderDocumentEntry | null; documents: OrderDocumentEntry[] }> {
  const caller = findCaller(params.callerLabel);
  const id = checkTrackingId(params.orderTrackingId);
  const type = params.contentType.split(";")[0].trim().toLowerCase();
  if (!ORDER_DOCUMENT_TYPES[type]) {
    throw new OrderDocumentError("Xcelerator only accepts PDF, JPG, PNG, GIF and BMP files on an order.", 415);
  }
  if (params.bytes.length > MAX_ORDER_DOCUMENT_BYTES) {
    throw new OrderDocumentError("Xcelerator only accepts files up to 25 MB on an order.", 413);
  }

  const { s, documents: before } = await listWithRetry(caller, id);

  const form = new FormData();
  form.append("FileUpload", new Blob([new Uint8Array(params.bytes)], { type }), params.fileName);
  let response: unknown;
  try {
    response = await portalJson<unknown>(
      s,
      `/ClientPortal/ClientPortal/api/trackingOnline/attachDocument?_p_OrderTrackingID=${id}&_p_Location=`,
      { method: "POST", body: form },
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new OrderDocumentError(`Xcelerator didn't accept the upload: ${why.slice(0, 200)}`);
  }
  if (response !== 1 && response !== "1") {
    throw new OrderDocumentError(`Xcelerator didn't accept the upload: ${String(response).slice(0, 200) || "no reason given"}`);
  }

  const documents = await fetchList(s, id).catch(() => before);
  const known = new Set(before.map((d) => d.id));
  return { added: documents.find((d) => !known.has(d.id)) ?? null, documents };
}
