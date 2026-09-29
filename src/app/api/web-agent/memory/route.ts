import { NextResponse } from "next/server";
import {
  loadMemory,
  memoryBackend,
  rankCallers,
  rankTrackBy,
  referenceContext,
  rememberedPlace,
  resetMemory,
} from "@/lib/web-agent-memory";
import { quickTrackFieldsFor } from "@/lib/web-agent";
import { xceleratorCallersFromEnv } from "@/lib/xcelerator-portal";

// GET  /api/web-agent/memory               -> what the web agent has learned
// GET  /api/web-agent/memory?ref=212620423M -> plus the caller order, the Quick Track fields it would try and where it was found before
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
    rememberedReferences: Object.keys(memory.places ?? {}).length,
    ...(context
      ? {
          ref,
          shape: context.shape,
          taxonomy: context.taxonomy,
          foundBefore: rememberedPlace(memory, ref ?? ""),
          callerOrder: rankCallers(memory, context, callers),
          plan: rankTrackBy(memory, context, quickTrackFieldsFor(ref ?? "")),
          callerPlans: Object.fromEntries(
            callers.map((c) => [c, rankTrackBy(memory, context, quickTrackFieldsFor(ref ?? ""), c).map((r) => r.trackBy)]),
          ),
        }
      : {}),
  });
}

export async function DELETE() {
  await resetMemory();
  return NextResponse.json({ reset: true });
}
