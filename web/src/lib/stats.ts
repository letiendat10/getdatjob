import { unstable_cache } from "next/cache";
import { supabase } from "./supabase";

export const getStats = unstable_cache(
  async () => {
    const [jobsRes, employersRes] = await Promise.all([
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
      supabase
        .from("employers")
        .select("id", { count: "exact", head: true }),
    ]);

    if (jobsRes.error) console.error("[stats] jobs count error:", jobsRes.error);
    if (employersRes.error) console.error("[stats] employers count error:", employersRes.error);

    const totalJobs = jobsRes.count ?? 0;
    const employerCount = employersRes.count ?? 0;

    // Refuse to cache obviously-wrong values — Next.js won't cache a thrown error,
    // so the next request will retry instead of serving zeros for an hour.
    if (totalJobs === 0) throw new Error("[stats] jobs count came back 0, skipping cache");

    return { totalJobs, employerCount };
  },
  ["site-stats-v3"],
  { revalidate: 300 }
);

/** Round down to nearest 100 and append "+" e.g. 12438 → "12,400+" */
export function formatStat(n: number): string {
  const rounded = Math.floor(n / 100) * 100;
  return rounded.toLocaleString("en-US") + "+";
}
