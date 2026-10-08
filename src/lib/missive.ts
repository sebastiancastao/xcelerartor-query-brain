// Server-side Missive REST client — deliberately minimal. Order-reference
// sensing needs the subject + body text of the message a CSR currently has
// open in Missive (see src/lib/reference-detection.ts for what happens to
// it). The documents panel needs the conversation's latest messages with
// their attachments and bodies (fetchConversationMessages below; see
// src/lib/email-documents.ts).

const API_BASE = "https://public.missiveapp.com/v1";

export function isMissiveConfigured(): boolean {
  return Boolean(process.env.MISSIVE_API_TOKEN);
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function missiveGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    const bodyText = await response.text();
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(JSON.parse(bodyText)?.error?.params?.retry_after) || 2;
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`Missive request failed ${path} (${response.status}): ${bodyText}`);
  }
  throw new Error("Missive request failed: exhausted retries");
}

type MissiveAddress = { name: string; address: string };

type MissiveConversation = {
  id: string;
  subject?: string | null;
  latest_message_subject?: string | null;
  external_authors?: MissiveAddress[];
  authors?: MissiveAddress[];
  last_activity_at?: number;
  messages_count?: number;
};

type MissiveMessageSummary = { id: string; delivered_at?: number | null };

type MissiveMessage = {
  id: string;
  subject: string | null;
  body: string | null;
  delivered_at: number | null;
  from_field: MissiveAddress | null;
};

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type MissiveConversationText = {
  subject: string;
  body: string;
  from: string;
  receivedAt: string;
};

/**
 * Fetches the subject + body of the latest message in a Missive
 * conversation — i.e. the email a CSR is currently looking at. Returns null
 * if the conversation has no messages (e.g. a brand-new draft).
 */
export async function fetchMissiveConversationText(
  conversationId: string
): Promise<MissiveConversationText | null> {
  const { conversations } = await missiveGet<{
    conversations: MissiveConversation | MissiveConversation[];
  }>(`/conversations/${conversationId}`, {});
  const conversation = Array.isArray(conversations) ? conversations[0] : conversations;
  if (!conversation || conversation.messages_count === 0) return null;

  // Missive rejects limit < 2 on this endpoint even though we only want the
  // single latest message (returned first / newest-first).
  const { messages: summaries } = await missiveGet<{ messages: MissiveMessageSummary[] }>(
    `/conversations/${conversationId}/messages`,
    { limit: "2" }
  );
  const latest = summaries[0];
  if (!latest) return null;

  const { messages } = await missiveGet<{ messages: MissiveMessage | MissiveMessage[] }>(
    `/messages/${latest.id}`,
    {}
  );
  const message = Array.isArray(messages) ? messages[0] : messages;
  if (!message) return null;

  const rawBody = message.body ?? "";
  const from =
    message.from_field?.address ??
    conversation.external_authors?.[0]?.address ??
    conversation.authors?.[0]?.address ??
    "";

  return {
    subject: message.subject ?? conversation.latest_message_subject ?? conversation.subject ?? "",
    body: looksLikeHtml(rawBody) ? stripHtml(rawBody) : rawBody,
    from,
    receivedAt: new Date(
      (message.delivered_at ?? conversation.last_activity_at ?? Date.now() / 1000) * 1000
    ).toISOString(),
  };
}

/** A file attached to a Missive message. `url` is a signed download link that expires after about 10 minutes. */
export type MissiveAttachment = {
  id: string;
  filename: string | null;
  extension: string | null;
  url: string | null;
  media_type: string | null;
  sub_type: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
};

export type MissiveThreadMessage = {
  id: string;
  subject: string | null;
  from: string;
  receivedAt: string | null;
  attachments: MissiveAttachment[];
  /** The message body (usually HTML); null unless bodies were asked for. */
  body: string | null;
};

type MissiveListedMessage = MissiveMessageSummary & {
  subject?: string | null;
  from_field?: MissiveAddress | null;
  attachments?: MissiveAttachment[] | null;
};

/**
 * The latest messages of a conversation (up to 10, Missive's page size),
 * newest first, with their attachments. Missive's message list already
 * carries attachments with fresh download links; bodies take one more
 * request, since /messages/<id1>,<id2>,... returns several messages at once.
 */
export async function fetchConversationMessages(
  conversationId: string,
  options: { bodies?: boolean } = {},
): Promise<MissiveThreadMessage[]> {
  const { messages: listed } = await missiveGet<{ messages: MissiveListedMessage[] }>(
    `/conversations/${conversationId}/messages`,
    { limit: "10" },
  );
  if (!listed?.length) return [];

  const bodies = new Map<string, string | null>();
  if (options.bodies) {
    const { messages } = await missiveGet<{ messages: MissiveMessage | MissiveMessage[] }>(
      `/messages/${listed.map((m) => m.id).join(",")}`,
      {},
    );
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      if (message) bodies.set(message.id, message.body ?? null);
    }
  }

  return listed.map((m) => ({
    id: m.id,
    subject: m.subject ?? null,
    from: m.from_field?.address ?? "",
    receivedAt: m.delivered_at ? new Date(m.delivered_at * 1000).toISOString() : null,
    attachments: m.attachments ?? [],
    body: bodies.get(m.id) ?? null,
  }));
}
