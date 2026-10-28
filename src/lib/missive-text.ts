// Turns a Missive message body into plain text. Shared by the server's REST
// client (src/lib/missive.ts) and the browser, which reads the open email
// through Missive's in-page API (src/components/MissiveEmailSense.tsx).

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

/** A Missive message body (usually HTML) as plain text. */
export function messageBodyText(body: string | null | undefined): string {
  const raw = body ?? "";
  return looksLikeHtml(raw) ? stripHtml(raw) : raw;
}
