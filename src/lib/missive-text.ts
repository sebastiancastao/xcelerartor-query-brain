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

// Where mail clients start the quoted earlier message in a reply's HTML:
// Gmail's gmail_quote, Outlook's divRplyFwdMsg / appendonsend, Apple Mail and
// others' blockquote.
const QUOTE_START_HTML = [/<blockquote\b/i, /class="[^"]*gmail_quote/i, /id="(?:divRplyFwdMsg|appendonsend)"/i];
// The same in plain text, as a line of its own.
const QUOTE_START_TEXT =
  /^\s*(?:On .{0,200}wrote:|-{2,}\s*Original Message|_{5,}|From:\s.*@|Sent from my |El .{0,200}escribi[oó]:)/im;

/**
 * Only what a message itself says: the earlier messages a reply quotes below
 * it are cut off, since they are read on their own. Capped at `maxChars`.
 */
export function newestBodyText(body: string | null | undefined, maxChars: number): string {
  let raw = (body ?? "").replace(/\r\n?/g, "\n");
  if (looksLikeHtml(raw)) {
    let cut = raw.length;
    for (const marker of QUOTE_START_HTML) {
      const at = raw.search(marker);
      if (at < 0) continue;
      // Cut at the start of the element that carries the marker.
      const tagStart = raw.lastIndexOf("<", at);
      cut = Math.min(cut, tagStart >= 0 ? tagStart : at);
    }
    raw = raw.slice(0, cut).replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/gi, "\n");
    raw = stripHtml(raw);
  }
  const textCut = raw.search(QUOTE_START_TEXT);
  const text = (textCut > 0 ? raw.slice(0, textCut) : raw).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)} [...]` : text;
}
