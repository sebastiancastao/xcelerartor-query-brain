import type { NextRequest } from "next/server";
import { mcpOther, mcpPost } from "@/lib/web-agent-mcp-http";

// The web agent's MCP server with the token in the path, for clients that
// can't send an Authorization header (claude.ai custom connectors): add
// https://<host>/api/web-agent/mcp/<one of WEB_AGENT_MCP_TOKEN's tokens>
// as the connector URL, with no OAuth client ID. Treat the URL as a secret.

// find_order runs a browser session plus several model turns per caller.
export const maxDuration = 300;

type Ctx = { params: Promise<{ token: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  return mcpPost(request, (await params).token);
}

export async function GET(request: NextRequest, { params }: Ctx) {
  return mcpOther(request, (await params).token);
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  return mcpOther(request, (await params).token);
}
