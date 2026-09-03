import type { OrderInquiry } from "./xcelerator";

function formatDateTime(iso: string | null): string {
  if (!iso) return "TBD";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "TBD";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount,
  );
}

export function buildSuggestedReply(order: OrderInquiry): string {
  const pickupLine = order.pickup.arrived
    ? `Yes — our driver arrived at pickup (${order.pickup.location}) on ${formatDateTime(order.pickup.arrivedAt)}.`
    : `Not yet — pickup at ${order.pickup.location} is currently scheduled for ${formatDateTime(order.pickup.scheduledAt)}.`;

  const deliveryLine = order.delivery.delivered
    ? `Yes — delivered to ${order.delivery.location} on ${formatDateTime(order.delivery.deliveredAt)}.`
    : `Not yet — delivery to ${order.delivery.location} is scheduled for ${formatDateTime(order.delivery.scheduledAt)}.`;

  const podIsLink = order.pod.documentUrl?.startsWith("http") ?? false;
  const podLine = order.pod.available
    ? `POD is on file${order.pod.receivedBy ? `, signed by ${order.pod.receivedBy}` : ""}.${
        podIsLink
          ? ` You can view it here: ${order.pod.documentUrl}`
          : " Let us know if you'd like a copy sent over."
      }`
    : `POD isn't available yet — we'll send it over as soon as it's received from the carrier.`;

  const chargesLine = order.charges.finalized
    ? `Final charges total ${formatCurrency(order.charges.total, order.charges.currency)}${
        order.charges.lineItems.length
          ? ` (${order.charges.lineItems
              .map((item) => `${item.label}: ${formatCurrency(item.amount, order.charges.currency)}`)
              .join(", ")})`
          : ""
      }.`
    : `Charges are still being finalized — we'll follow up with a final invoice once billing confirms.`;

  return [
    `Hi ${order.customer},`,
    "",
    `Thanks for reaching out about order ${order.referenceNumber}. Here's the latest:`,
    "",
    `- Pickup: ${pickupLine}`,
    `- Delivery: ${deliveryLine}`,
    `- POD: ${podLine}`,
    `- Charges: ${chargesLine}`,
    "",
    "Let us know if you need anything else!",
  ].join("\n");
}
