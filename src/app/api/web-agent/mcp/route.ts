import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { handleMcpMessage } from "@/lib/web-agent-mcp";

// The web agent as an MCP server (Streamable HTTP, stateless). Point an MCP
// client at https://<host>/api/web-agent/mcp with the header
// "Authorization: Bearer <WEB_AGENT_MCP_TOKEN>". Without that variable set
// the endpoint stays off: its tools sign in to Xcelerator and can save quotes.

// find_order runs a browser session plus several model turns per caller.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const expected = process.env.WEB_AGENT_MCP_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function refuse(request: NextRequest): NextResponse | null {
  if (!process.env.WEB_AGENT_MCP_TOKEN?.trim()) {
    return NextResponse.json({ error: "The MCP server is off (set WEB_AGENT_MCP_TOKEN)." }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="web-agent-mcp"' } },
    );
  }
  return null;
}

export async function POST(request: NextRequest) {
  const refused = refuse(request);
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

// This server opens no server-to-client stream and keeps no sessions.
export async function GET(request: NextRequest) {
  const refused = refuse(request);
  if (refused) return refused;
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE(request: NextRequest) {
  const refused = refuse(request);
  if (refused) return refused;
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
