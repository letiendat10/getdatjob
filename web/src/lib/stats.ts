import { unstable_cache } from "next/cache";
import { supabase } from "./supabase";

export const getStats = unstable_cache(
  async () => {
    const [{ count: totalJobs }, { count: employerCount }] = await Promise.all([
      supabase
        .from("jobs_with_details")
        .select("id", { count: "exact", head: true }),
      supabase
        .from("employers")
        .select("id", { count: "exact", head: true }),
    ]);

    return {
      totalJobs: totalJobs ?? 0,
      employerCount: employerCount ?? 0,
    };
  },
  ["site-stats-v1"],
  { revalidate: 3600 }
);

/** Round down to nearest 100 and append "+" e.g. 12438 → "12,400+" */
export function formatStat(n: number): string {
  const rounded = Math.floor(n / 100) * 100;
  return rounded.toLocaleString("en-US") + "+";
}
