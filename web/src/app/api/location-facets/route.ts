import { createClient } from "@supabase/supabase-js";
import { normalizeCityState } from "@/lib/location";

// Valid US state abbreviations — used to filter out non-US and malformed locations
// (hospital campus names, city-only strings without a state, non-US cities).
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
]);

// Special normalized values that are not "City, ST" but should still appear.
const KEEP_SPECIAL = new Set(["Remote", "Multiple Locations", "Nationwide"]);

export const revalidate = 3600; // CDN-cached for 1h; refreshes as new jobs are pulled

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data, error } = await supabase.rpc("location_facets", { p_limit: 1000 });
  if (error || !data) return Response.json([]);

  // Normalize each raw location, group by the normalized form, sum counts.
  const counts = new Map<string, number>();
  for (const row of data as { location: string; is_remote: boolean; job_count: string | number }[]) {
    // is_remote=true rows always map to "Remote" regardless of location text.
    const norm = normalizeCityState(row.location, row.is_remote);
    if (!norm) continue;

    if (!KEEP_SPECIAL.has(norm)) {
      // Require "City, ST" format with a valid US state so hospital names,
      // city-only strings ("Boston", "Charleston"), and non-US cities are dropped.
      const parts = norm.split(", ");
      if (parts.length < 2) continue;
      if (!US_STATES.has(parts[parts.length - 1])) continue;
    }

    counts.set(norm, (counts.get(norm) ?? 0) + Number(row.job_count));
  }

  // Sort by count desc, cap at top 100 for a manageable dropdown.
  const options = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([label]) => ({ label, value: label }));

  return Response.json(options);
}
