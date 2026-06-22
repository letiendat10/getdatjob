/**
 * Normalize a raw ATS location string to "City, ST" display format.
 *
 * Pass `isRemote` (from the DB boolean) so the authoritative scraper flag drives
 * the "Remote" label rather than re-detecting it from the raw string.
 *
 * Handles:
 *   "US, WA, Seattle"                        → "Seattle, WA"   (Amazon format)
 *   "Austin, Texas, United States of America" → "Austin, TX"
 *   "Long Beach, CA, United States"           → "Long Beach, CA"
 *   "San Jose, California, US"                → "San Jose, CA"
 *   "Jersey City, NJ"                         → "Jersey City, NJ"
 *   "2 Locations" / "49 Locations"            → "Multiple Locations"
 *   "" / null                                 → ""
 */

const STATE_ABBREVS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

export function normalizeCityState(
  loc: string | null | undefined,
  isRemote?: boolean | null,
): string {
  const raw = (loc ?? "").trim();
  if (!raw) return "";

  // "N Locations" — Workday multi-site jobs collapse locations to a count
  if (/^\d+ [Ll]ocation/.test(raw)) return "Multiple Locations";

  // is_remote DB boolean is authoritative for the "Remote" label
  if (isRemote) return "Remote";

  // Standalone "United States" / "USA" / "US" with no city info
  if (/^(united states(?: of america)?|usa|us)$/i.test(raw)) return "Nationwide";

  // Amazon format: "US, WA, Seattle" → "Seattle, WA"
  const amz = raw.match(/^US,\s*([A-Z]{2}),\s*(.+)$/i);
  if (amz) return `${amz[2].trim()}, ${amz[1].toUpperCase()}`;

  // Dash-separated US formats:
  //   "US-CA-Menlo Park" → "Menlo Park, CA"
  const usDash = raw.match(/^US-([A-Z]{2})-(.+)$/i);
  if (usDash) return `${usDash[2].trim()}, ${usDash[1].toUpperCase()}`;

  //   "California - San Francisco" / "Washington - Bellevue" → "City, ST"
  const stateDash = raw.match(/^([A-Za-z ]+?) - (.+)$/);
  if (stateDash) {
    const abbrev = STATE_ABBREVS[stateDash[1].toLowerCase().trim()];
    if (abbrev) return `${stateDash[2].trim()}, ${abbrev}`;
  }

  // Semicolon-separated multi-city strings (e.g. "Chicago, IL; San Francisco, CA") — take first only
  let s = raw.split(";")[0].trim();

  // Strip trailing country suffixes, then ZIP code
  s = s
    .replace(/,?\s*united states of america$/i, "")
    .replace(/,?\s*united states$/i, "")
    .replace(/,?\s*\bU\.?S\.?A?\.?\b$/i, "")
    .replace(/,?\s*\d{5}(-\d{4})?$/, "")
    .trim();

  // Split on ", " and take first two segments
  const parts = s.split(/,\s*/);
  if (parts.length >= 2) {
    const city = parts[0].trim();
    const rawState = parts[1].trim();
    // Map full state name → 2-letter abbreviation, or pass through if already abbrev
    const abbrev = STATE_ABBREVS[rawState.toLowerCase()];
    const state = abbrev ?? rawState;
    return `${city}, ${state.toUpperCase()}`;
  }

  // Fallback: city only (no state available)
  return parts[0].trim();
}
