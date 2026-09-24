import { NextResponse } from "next/server";
import { isDebugEnabled } from "@/lib/debug-log";
import { collectDebugStatus } from "@/lib/debug-status";

// GET /api/debug/status — configuration and runtime state for the /debug page.
// Read-only. Never includes passwords, tokens, or API keys, only whether
// each is set. Disabled in production unless ENABLE_DEBUG_PAGE=true.
export async function GET() {
  if (!isDebugEnabled()) {
    return NextResponse.json(
      { error: "Debug tools are disabled in production. Set ENABLE_DEBUG_PAGE=true to enable them." },
      { status: 404 },
    );
  }
  return NextResponse.json(collectDebugStatus());
}
