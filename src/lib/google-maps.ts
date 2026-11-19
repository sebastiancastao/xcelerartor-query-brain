// Google Maps for quotes: driving distance between two places (Routes API),
// and a place's street, city, state and ZIP (Places Text Search when the key
// has it, else Geocoding). Plain fetch, server side only so the key never
// reaches the browser.

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

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/** A place split into the address fields an order needs. Empty strings where Google gave nothing. */
export type GeocodedPlace = {
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Google's whole address, for showing what was matched. */
  formatted: string;
  /** True when Google only matched an area (a city), not a street address. */
  areaOnly: boolean;
};

type GeocodeResult = {
  formatted_address?: string;
  address_components?: { long_name: string; short_name: string; types: string[] }[];
  geometry?: { location?: { lat: number; lng: number } };
  types?: string[];
};

async function geocode(params: Record<string, string>): Promise<GeocodeResult[]> {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ ...params, key: apiKey(), region: "us" })}`;
  let body: { status?: string; error_message?: string; results?: GeocodeResult[] } | null;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    body = (await res.json().catch(() => null)) as typeof body;
  } catch {
    throw new RouteMilesError(502, "Google Maps did not answer the address lookup.");
  }
  if (body?.status === "REQUEST_DENIED") {
    throw new RouteMilesError(502, `Google Maps refused the address lookup: ${body.error_message ?? "turn on the Geocoding API for the key"}.`);
  }
  return body?.status === "OK" ? (body.results ?? []) : [];
}

function component(result: GeocodeResult, type: string, short = false): string {
  const c = result.address_components?.find((x) => x.types.includes(type));
  return (short ? c?.short_name : c?.long_name) ?? "";
}

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// Set once Google refuses Places for this key (the API isn't turned on), so later lookups go straight to Geocoding.
let placesRefused = false;

type PlacesResult = {
  formattedAddress?: string;
  addressComponents?: { longText: string; shortText: string; types: string[] }[];
};

/**
 * A business or place by name through Places Text Search, which finds
 * businesses ("Northside Hospital Forsyth") far better than Geocoding does.
 * Null when Places isn't available for the key or finds nothing.
 */
async function placesLookup(place: string): Promise<GeocodedPlace | null> {
  if (placesRefused) return null;
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey(),
        "X-Goog-FieldMask": "places.formattedAddress,places.addressComponents",
      },
      body: JSON.stringify({ textQuery: routeAddress(place), regionCode: "us", maxResultCount: 1 }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      placesRefused = true;
      return null;
    }
    const body = (await res.json().catch(() => null)) as { places?: PlacesResult[] } | null;
    const found = body?.places?.[0];
    if (!res.ok || !found?.addressComponents) return null;
    const part = (type: string, short = false) => {
      const c = found.addressComponents!.find((x) => x.types.includes(type));
      return (short ? c?.shortText : c?.longText) ?? "";
    };
    const street = [part("street_number"), part("route", true)].filter(Boolean).join(" ");
    const zip = part("postal_code");
    if (!street || !zip) return null;
    return {
      street,
      city: part("locality") || part("sublocality") || part("neighborhood") || part("administrative_area_level_3"),
      state: part("administrative_area_level_1", true),
      zip,
      formatted: found.formattedAddress ?? "",
      areaOnly: false,
    };
  } catch {
    return null;
  }
}

/**
 * Street, city, state and ZIP for a place as an email names it ("Piedmont
 * Atlanta Hospital, 1968 Peachtree Rd NW, Atlanta" or "LabCorp in Norcross").
 * Places is asked first, for business names, then Geocoding. When Google
 * matches only a city it has no ZIP, so the ZIP of the city's center is
 * used. Null when Google finds nothing.
 */
export async function geocodePlace(place: string): Promise<GeocodedPlace | null> {
  if (!isGoogleMapsConfigured()) {
    throw new RouteMilesError(501, "Google Maps isn't connected yet (set GOOGLE_MAPS_API_KEY), so addresses can't be looked up.");
  }
  const byName = await placesLookup(place);
  if (byName) return byName;
  const result = (await geocode({ address: routeAddress(place) }))[0];
  if (!result) return null;
  const areaOnly = !component(result, "route");
  let zip = component(result, "postal_code");
  const at = result.geometry?.location;
  if (!zip && at) {
    const near = await geocode({ latlng: `${at.lat},${at.lng}`, result_type: "postal_code" });
    zip = near[0] ? component(near[0], "postal_code") : "";
  }
  const street = [component(result, "street_number"), component(result, "route", true)].filter(Boolean).join(" ");
  return {
    street,
    city:
      component(result, "locality") ||
      component(result, "sublocality") ||
      component(result, "neighborhood") ||
      component(result, "administrative_area_level_3"),
    state: component(result, "administrative_area_level_1", true),
    zip,
    formatted: result.formatted_address ?? "",
    areaOnly,
  };
}

/** Driving miles from `from` to `to`, by Google's default (fastest) route without live traffic. */
export async function routeMiles(from: string, to: string): Promise<RouteMiles> {
  if (!isGoogleMapsConfigured()) {
    throw new RouteMilesError(501, "Google Maps isn't connected yet (set GOOGLE_MAPS_API_KEY), so enter the miles by hand.");
  }
  // Business names resolve to the right building through Places when it is on for the key.
  const [origin, destination] = await Promise.all(
    [from, to].map(async (place) => (await placesLookup(place))?.formatted || routeAddress(place)),
  );
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
        origin: { address: origin },
        destination: { address: destination },
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
