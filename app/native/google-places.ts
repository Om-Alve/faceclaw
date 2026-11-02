/**
 * Google Places API (New) Text Search, for the Navigate app's destination
 * lookup. Google's index finds many businesses and landmarks that Mapbox
 * Search Box misses, so when a key is set it turns a spoken destination into
 * coordinates. Routing and the map pane stay on Mapbox. The key lives in
 * settings under "maps.googlePlacesApiKey".
 */
import { getStringSetting } from "./settings-store";
import { fetchTextWithUserAgent } from "../util/http";
import type { GeocodeCandidate } from "./mapbox";

export const GOOGLE_PLACES_KEY_SETTING_KEY = "maps.googlePlacesApiKey";
const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
/**
 * Only fields billed under the Text Search Pro SKU. Asking for anything
 * Enterprise-tier (rating, opening hours, phone) would bill every search at
 * that tier instead.
 */
const FIELD_MASK = "places.displayName,places.shortFormattedAddress,places.formattedAddress,places.location";
/** A soft bias around the user; Google still returns matches outside it. */
const BIAS_RADIUS_M = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

export function getGooglePlacesKey(): string {
  return (getStringSetting(GOOGLE_PLACES_KEY_SETTING_KEY, "") ?? "").trim();
}

export function isGooglePlacesConfigured(): boolean {
  return getGooglePlacesKey().length > 0;
}

/** Resolve a free-text destination, biased toward the given location. */
export async function searchGooglePlaces(
  query: string,
  proximity: { longitude: number; latitude: number } | null,
  limit = 5,
): Promise<GeocodeCandidate[]> {
  const key = getGooglePlacesKey();
  if (!key) throw new Error("Set a Google Places key in Settings > API Keys first.");
  const request: Record<string, unknown> = {
    textQuery: query,
    pageSize: limit,
    languageCode: "en",
  };
  if (proximity) {
    request.locationBias = {
      circle: {
        center: { latitude: proximity.latitude, longitude: proximity.longitude },
        radius: BIAS_RADIUS_M,
      },
    };
  }
  const response = await fetchTextWithUserAgent(TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(request),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body; the status code below says enough.
  }
  if (!response.ok) {
    const detail = String(body?.error?.message ?? "").trim();
    throw new Error(`Google Places search failed (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`);
  }
  return parseTextSearchResponse(body);
}

/** Map a Text Search (New) response body onto geocode candidates, skipping places without a location. */
export function parseTextSearchResponse(body: any): GeocodeCandidate[] {
  const places = Array.isArray(body?.places) ? body.places : [];
  const candidates: GeocodeCandidate[] = [];
  for (const place of places) {
    const latitude = toFinite(place?.location?.latitude);
    const longitude = toFinite(place?.location?.longitude);
    if (latitude === null || longitude === null) continue;
    candidates.push({
      name: String(place?.displayName?.text ?? "").trim() || "(unnamed)",
      placeFormatted: String(place?.shortFormattedAddress ?? place?.formattedAddress ?? "").trim(),
      longitude,
      latitude,
      // Text Search doesn't report distance, and nothing downstream needs it.
      distanceMeters: null,
    });
  }
  return candidates;
}

function toFinite(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}
