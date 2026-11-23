import type { NextRequest } from "next/server";
import { mcpOther, mcpPost } from "@/lib/web-agent-mcp-http";

// The web agent as an MCP server. Point an MCP client at
// https://<host>/api/web-agent/mcp with the header
// "Authorization: Bearer <one of WEB_AGENT_MCP_TOKEN's tokens>".
// Clients that can't send headers use /api/web-agent/mcp/<token> instead.

// find_order runs a browser session plus several model turns per caller.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return mcpPost(request);
}

export async function GET(request: NextRequest) {
  return mcpOther(request);
}

export async function DELETE(request: NextRequest) {
  return mcpOther(request);
}
