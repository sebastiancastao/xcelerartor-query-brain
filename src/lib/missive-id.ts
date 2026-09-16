// Missive's iframe SDK and REST API hand back conversation identifiers in a
// grab-bag of shapes (a bare id, an object with `id`/`conversation_id`, an
// array of ids, a web/app URL containing the id, …). This pulls the UUID out
// of whatever shape shows up, so callers don't need to know which one Missive
// sent this time.

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractUuid(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const match = String(value).match(UUID_PATTERN);
    return match ? match[0].toLowerCase() : null;
  }

  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of [
    "id",
    "ids",
    "conversation_id",
    "conversationId",
    "conversationIds",
    "conversation",
    "conversations",
    "link",
    "web_url",
    "app_url",
  ]) {
    const uuid = extractUuid(record[key]);
    if (uuid) return uuid;
  }

  return null;
}

export function extractUuids(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const uuids: string[] = [];

  for (const item of values) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const key of ["ids", "conversationIds", "conversations"]) {
        for (const uuid of extractUuids((item as Record<string, unknown>)[key])) {
          if (!seen.has(uuid)) {
            seen.add(uuid);
            uuids.push(uuid);
          }
        }
      }
    }

    const uuid = extractUuid(item);
    if (!uuid || seen.has(uuid)) {
      continue;
    }

    seen.add(uuid);
    uuids.push(uuid);
  }

  return uuids;
}
