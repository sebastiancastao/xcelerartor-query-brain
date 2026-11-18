// Driving distance between two places, from the Google Maps Routes API
// (plain fetch, server side only so the key never reaches the browser).

import { routeAddress } from "./quote-types";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const METERS_PER_MILE = 1609.344;
const TIMEOUT_MS = 10000;

function apiKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "";
}

export function isGoogleMapsConfigured(): boolean {
  return apiKey().length > 0;
}

/** A route that could not be measured. `status` is the HTTP status to answer the page with. */
export class RouteMilesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RouteMiles = { miles: number; minutes: number | null };

/** Driving miles from `from` to `to`, by Google's default (fastest) route without live traffic. */
export async function routeMiles(from: string, to: string): Promise<RouteMiles> {
  if (!isGoogleMapsConfigured()) {
    throw new RouteMilesError(501, "Google Maps isn't connected yet (set GOOGLE_MAPS_API_KEY), so enter the miles by hand.");
  }
  let response: Response;
  try {
    response = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey(),
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { address: routeAddress(from) },
        destination: { address: routeAddress(to) },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        regionCode: "us",
        units: "IMPERIAL",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RouteMilesError(502, "Google Maps did not answer. Try again, or enter the miles by hand.");
  }

  const body = (await response.json().catch(() => null)) as {
    routes?: { distanceMeters?: number; duration?: string }[];
    error?: { message?: string; status?: string };
  } | null;

  if (!response.ok) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    if (/API key not valid/i.test(detail)) throw new RouteMilesError(502, "Google Maps rejected GOOGLE_MAPS_API_KEY.");
    if (body?.error?.status === "PERMISSION_DENIED") {
      throw new RouteMilesError(
        502,
        "Google Maps refused the request: the key's Google Cloud project needs billing on and the Routes API turned on, and the key must not be limited to websites (HTTP referrers).",
      );
    }
    if (response.status === 400) {
      throw new RouteMilesError(422, "Google Maps couldn't find one of these places. Make the address more specific.");
    }
    throw new RouteMilesError(502, `Google Maps error: ${detail}`);
  }

  const route = body?.routes?.[0];
  if (!route || typeof route.distanceMeters !== "number") {
    throw new RouteMilesError(422, "Google Maps found no driving route between these places. Check both addresses.");
  }
  const seconds = typeof route.duration === "string" ? Number.parseFloat(route.duration) : NaN;
  return {
    miles: Math.round((route.distanceMeters / METERS_PER_MILE) * 10) / 10,
    minutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : null,
  };
}
