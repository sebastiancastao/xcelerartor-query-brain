import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { handleMcpMessage } from "@/lib/web-agent-mcp";

// HTTP side of the web agent's MCP server (Streamable HTTP, stateless), shared
// by the two routes:
//   /api/web-agent/mcp          token in "Authorization: Bearer <token>"
//   /api/web-agent/mcp/<token>  token in the path, for clients that can't send
//                               headers (claude.ai custom connectors)
// WEB_AGENT_MCP_TOKEN holds one or more comma-separated tokens, one per
// client, so a token can be added or revoked without breaking the others.
// Without it the server stays off: its tools sign in to Xcelerator and can
// save quotes.

function allowedTokens(): string[] {
  return (process.env.WEB_AGENT_MCP_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function tokenAllowed(token: string): boolean {
  const given = Buffer.from(token.trim());
  if (given.length === 0) return false;
  return allowedTokens().some((allowed) => {
    const expected = Buffer.from(allowed);
    return expected.length === given.length && timingSafeEqual(given, expected);
  });
}

function bearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

// pathToken undefined = header route; a string = path route.
function refuse(request: NextRequest, pathToken: string | undefined): NextResponse | null {
  if (allowedTokens().length === 0) {
    return NextResponse.json({ error: "The MCP server is off (set WEB_AGENT_MCP_TOKEN)." }, { status: 503 });
  }
  if (pathToken !== undefined) {
    // A 404, not a 401: a 401 makes claude.ai start an OAuth sign-in this
    // server doesn't offer, which hides the real problem (a wrong URL).
    return tokenAllowed(pathToken) ? null : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!tokenAllowed(bearerToken(request))) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="web-agent-mcp"' } },
    );
  }
  return null;
}

export async function mcpPost(request: NextRequest, pathToken?: string): Promise<NextResponse> {
  const refused = refuse(request, pathToken);
  if (refused) return refused;

  const body = await request.json().catch(() => undefined);
  if (body === undefined) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  // A batch (older protocol versions) or a single message.
  const messages = Array.isArray(body) ? body : [body];
  const answers = (await Promise.all(messages.map((m) => handleMcpMessage(m ?? {})))).filter((a) => a !== null);

  // Only notifications or responses: accepted, nothing to answer.
  if (answers.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? answers : answers[0]);
}

// This server opens no server-to-client stream and keeps no sessions, so GET
// and DELETE only check access and answer 405.
export function mcpOther(request: NextRequest, pathToken?: string): NextResponse {
  return refuse(request, pathToken) ?? new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
