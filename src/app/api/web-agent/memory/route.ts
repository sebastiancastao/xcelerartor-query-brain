import { NextResponse } from "next/server";
import { loadMemory, memoryBackend, rankTrackBy, referenceShape, resetMemory } from "@/lib/web-agent-memory";
import { TRACK_BY_OPTIONS } from "@/lib/web-agent";

// GET  /api/web-agent/memory            -> what the web agent has learned
// GET  /api/web-agent/memory?ref=1088033 -> plus the search order it would use for that reference
// DELETE /api/web-agent/memory          -> forget everything and start over
export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref");
  const memory = await loadMemory();
  const shape = ref ? referenceShape(ref) : null;

  return NextResponse.json({
    storage: memoryBackend(),
    shapes: memory.shapes,
    global: memory.global,
    callers: memory.callers,
    exploration: memory.exploration ?? {},
    recentEpisodes: memory.episodes.slice(-25),
    ...(shape ? { ref, shape, plan: rankTrackBy(memory, shape, TRACK_BY_OPTIONS) } : {}),
  });
}

export async function DELETE() {
  await resetMemory();
  return NextResponse.json({ reset: true });
}
