// Server-side Missive REST client — deliberately minimal. Order-reference
// sensing needs the subject + body text of the message a CSR currently has
// open in Missive (see src/lib/reference-detection.ts for what happens to
// it). The documents panel needs the conversation's latest messages with
// their attachments and bodies (fetchConversationMessages below; see
// src/lib/email-documents.ts).
//
// A Missive API token acts as the user who made it and sees only the
// conversations that user can see. The browser therefore reads the open
// email through Missive's in-page API first (it runs as whoever is signed
// in); this client is its fallback and the documents panel's source. To
// reach emails the main token's user can't see, such as a CSR's personal
// inbox, the app can hold more tokens (MISSIVE_API_TOKEN_<NAME>, one per
// CSR) and uses whichever one can see the conversation.

import { messageBodyText } from "./missive-text";

const API_BASE = "https://public.missiveapp.com/v1";

/**
 * Missive answers 404 both for conversations that don't exist and for ones
 * the token's user can't see, such as an email in another user's personal
 * inbox. An email open in Missive exists, so it is the second case.
 */
export class MissiveNotVisibleError extends Error {
  constructor(path: string) {
    super(`None of the app's Missive API tokens can see this email (Missive answered 404 for ${path}).`);
    this.name = "MissiveNotVisibleError";
  }
}

/** Missive rejected the token itself (revoked or mistyped). */
class MissiveTokenRejectedError extends Error {
  constructor(path: string, status: number, bodyText: string) {
    super(`Missive request failed ${path} (${status}): ${bodyText}`);
    this.name = "MissiveTokenRejectedError";
  }
}

/**
 * Every Missive API token the app has: MISSIVE_API_TOKEN first, then each
 * MISSIVE_API_TOKEN_<NAME> (e.g. MISSIVE_API_TOKEN_BRETT) in name order.
 */
function missiveTokens(): string[] {
  const extra = Object.keys(process.env)
    .filter((key) => /^MISSIVE_API_TOKEN_\w+$/.test(key))
    .sort()
    .map((key) => process.env[key]?.trim() ?? "");
  return [...new Set([process.env.MISSIVE_API_TOKEN?.trim() ?? "", ...extra].filter(Boolean))];
}

export function isMissiveConfigured(): boolean {
  return missiveTokens().length > 0;
}

/** How many Missive API tokens are set, for the debug page. */
export function missiveTokenCount(): number {
  return missiveTokens().length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function missiveGet<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    const bodyText = await response.text();
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(JSON.parse(bodyText)?.error?.params?.retry_after) || 2;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (response.status === 404) throw new MissiveNotVisibleError(path);
    if (response.status === 401 || response.status === 403) {
      throw new MissiveTokenRejectedError(path, response.status, bodyText);
    }
    throw new Error(`Missive request failed ${path} (${response.status}): ${bodyText}`);
  }
  throw new Error("Missive request failed: exhausted retries");
}

/** A GET to Missive bound to one token. */
type MissiveGetter = <R>(path: string, params: Record<string, string>) => Promise<R>;

/** Which token last saw each conversation, so the next request tries it first. */
const tokenByConversation = new Map<string, string>();
const MAX_REMEMBERED_CONVERSATIONS = 500;

/**
 * Runs `read` with the first token that can see the conversation: the one
 * that saw it last, then the others in order. A token whose user can't see
 * it (404) or that Missive rejects (401/403) moves on to the next one; any
 * other failure stops. With a single token this is a plain call.
 */
async function withConversationToken<T>(
  conversationId: string,
  read: (get: MissiveGetter) => Promise<T>,
): Promise<T> {
  const tokens = missiveTokens();
  if (tokens.length === 0) throw new Error("Missive is not configured (set MISSIVE_API_TOKEN).");
  const known = tokenByConversation.get(conversationId);
  const ordered = known && tokens.includes(known) ? [known, ...tokens.filter((t) => t !== known)] : tokens;

  let notVisible: MissiveNotVisibleError | null = null;
  let rejected: MissiveTokenRejectedError | null = null;
  for (const token of ordered) {
    try {
      const result = await read((path, params) => missiveGet(token, path, params));
      tokenByConversation.delete(conversationId);
      tokenByConversation.set(conversationId, token);
      if (tokenByConversation.size > MAX_REMEMBERED_CONVERSATIONS) {
        tokenByConversation.delete(tokenByConversation.keys().next().value as string);
      }
      return result;
    } catch (error) {
      if (error instanceof MissiveNotVisibleError) notVisible ??= error;
      else if (error instanceof MissiveTokenRejectedError) rejected ??= error;
      else throw error;
    }
  }
  throw notVisible ?? rejected ?? new Error("Missive request failed.");
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

export type MissiveConversationText = {
  subject: string;
  body: string;
  from: string;
  /** The sender's display name, when Missive has one. */
  fromName: string;
  receivedAt: string;
};

/**
 * Fetches the subject + body of the latest message in a Missive
 * conversation — i.e. the email a CSR is currently looking at. Returns null
 * if the conversation has no messages (e.g. a brand-new draft).
 */
export function fetchMissiveConversationText(
  conversationId: string
): Promise<MissiveConversationText | null> {
  return withConversationToken(conversationId, (get) => readConversationText(conversationId, get));
}

async function readConversationText(
  conversationId: string,
  get: MissiveGetter,
): Promise<MissiveConversationText | null> {
  const { conversations } = await get<{
    conversations: MissiveConversation | MissiveConversation[];
  }>(`/conversations/${conversationId}`, {});
  const conversation = Array.isArray(conversations) ? conversations[0] : conversations;
  if (!conversation || conversation.messages_count === 0) return null;

  // Missive rejects limit < 2 on this endpoint even though we only want the
  // single latest message (returned first / newest-first).
  const { messages: summaries } = await get<{ messages: MissiveMessageSummary[] }>(
    `/conversations/${conversationId}/messages`,
    { limit: "2" }
  );
  const latest = summaries[0];
  if (!latest) return null;

  const { messages } = await get<{ messages: MissiveMessage | MissiveMessage[] }>(
    `/messages/${latest.id}`,
    {}
  );
  const message = Array.isArray(messages) ? messages[0] : messages;
  if (!message) return null;

  const from =
    message.from_field?.address ??
    conversation.external_authors?.[0]?.address ??
    conversation.authors?.[0]?.address ??
    "";

  return {
    subject: message.subject ?? conversation.latest_message_subject ?? conversation.subject ?? "",
    body: messageBodyText(message.body),
    from,
    fromName: message.from_field?.name ?? "",
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
export function fetchConversationMessages(
  conversationId: string,
  options: { bodies?: boolean } = {},
): Promise<MissiveThreadMessage[]> {
  return withConversationToken(conversationId, (get) => readConversationMessages(conversationId, options, get));
}

async function readConversationMessages(
  conversationId: string,
  options: { bodies?: boolean },
  get: MissiveGetter,
): Promise<MissiveThreadMessage[]> {
  const { messages: listed } = await get<{ messages: MissiveListedMessage[] }>(
    `/conversations/${conversationId}/messages`,
    { limit: "10" },
  );
  if (!listed?.length) return [];

  const bodies = new Map<string, string | null>();
  if (options.bodies) {
    const { messages } = await get<{ messages: MissiveMessage | MissiveMessage[] }>(
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
