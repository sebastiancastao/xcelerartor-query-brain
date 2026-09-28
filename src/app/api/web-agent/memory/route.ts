import { NextResponse } from "next/server";
import {
  loadMemory,
  memoryBackend,
  rankCallers,
  rankTrackBy,
  referenceContext,
  resetMemory,
} from "@/lib/web-agent-memory";
import { TRACK_BY_OPTIONS } from "@/lib/web-agent";
import { xceleratorCallersFromEnv } from "@/lib/xcelerator-portal";

// GET  /api/web-agent/memory               -> what the web agent has learned
// GET  /api/web-agent/memory?ref=212620423M -> plus the caller order and fields it would use for that reference
// DELETE /api/web-agent/memory             -> forget everything and start over
export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref");
  const memory = await loadMemory();
  const context = ref ? referenceContext(ref) : null;
  const callers = xceleratorCallersFromEnv().map((c) => c.label);

  return NextResponse.json({
    storage: memoryBackend(),
    shapes: memory.shapes,
    global: memory.global,
    callers: memory.callers,
    typeCallers: memory.typeCallers ?? {},
    callerFields: memory.callerFields ?? {},
    exploration: memory.exploration ?? {},
    recentEpisodes: memory.episodes.slice(-25),
    ...(context
      ? {
          ref,
          shape: context.shape,
          taxonomy: context.taxonomy,
          callerOrder: rankCallers(memory, context, callers),
          plan: rankTrackBy(memory, context, TRACK_BY_OPTIONS),
          callerPlans: Object.fromEntries(
            callers.map((c) => [c, rankTrackBy(memory, context, TRACK_BY_OPTIONS, c).map((r) => r.trackBy)]),
          ),
        }
      : {}),
  });
}

export async function DELETE() {
  await resetMemory();
  return NextResponse.json({ reset: true });
}
