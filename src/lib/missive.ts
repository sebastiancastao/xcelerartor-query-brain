// Server-side Missive REST client — deliberately minimal. All we need for
// order-reference sensing is the subject + body text of the message a CSR
// currently has open in Missive; we don't fetch attachments, classify
// documents, or scan whole conversation histories the way a full ticketing
// integration would. See src/lib/reference-detection.ts for what happens to
// this text once it comes back.

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
