import { NextResponse } from "next/server";
import { RouteMilesError, routeMiles } from "@/lib/google-maps";

function place(value: unknown): string | null {
  return typeof value === "string" && value.trim().length >= 3 ? value.trim().slice(0, 300) : null;
}

/** Driving miles between the quote's pickup and delivery places, from Google Maps. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const from = place(body?.from);
  const to = place(body?.to);
  if (!from || !to) return NextResponse.json({ error: "Enter both the pickup and the delivery place." }, { status: 400 });

  try {
    return NextResponse.json(await routeMiles(from, to));
  } catch (err) {
    if (err instanceof RouteMilesError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Could not get the miles from Google Maps." }, { status: 502 });
  }
}
