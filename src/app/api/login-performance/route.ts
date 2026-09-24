import { NextResponse } from "next/server";
import { loginPerformanceSnapshot } from "@/lib/xcelerator";

// GET /api/login-performance — what the adaptive layer (see
// src/lib/login-performance.ts) has learned so far this server process:
// each login's average latency, sample count, and whether its circuit
// breaker is currently open. Empty until at least one real lookup or
// caller search has run against a live login. Read-only, no side effects.
export async function GET() {
  return NextResponse.json({ logins: loginPerformanceSnapshot() });
}
