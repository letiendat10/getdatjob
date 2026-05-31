import { unstable_cache } from "next/cache";
import { supabase } from "./supabase";

export interface VisaStat { jobs: number; employers: number }

export const getStats = unstable_cache(
  async () => {
    const { data, error } = await supabase
      .from("stats_shelf")
      .select("visa_type, job_count, employer_count");

    if (error) throw new Error(`[stats] shelf error: ${error.message}`);
    if (!data || data.length === 0) throw new Error("[stats] shelf empty");

    const byVisa = Object.fromEntries(
      data.map((r) => [r.visa_type, { jobs: r.job_count as number, employers: r.employer_count as number }])
    );

    const all = byVisa["all"];
    const totalSponsors = byVisa["total_sponsors"];
    if (!all || all.jobs === 0) throw new Error("[stats] total jobs came back 0, skipping cache");

    return {
      totalJobs: all.jobs,
      // Hero laurel: all USCIS-verified sponsors in DB (not just those with active jobs)
      employerCount: totalSponsors?.employers ?? all.employers,
      byVisa: {
        h1b: byVisa["h1b"] ?? { jobs: 0, employers: 0 },
        e3:  byVisa["e3"]  ?? { jobs: 0, employers: 0 },
        tn:  byVisa["tn"]  ?? { jobs: 0, employers: 0 },
        opt: byVisa["opt"] ?? { jobs: 0, employers: 0 },
      } as Record<string, VisaStat>,
    };
  },
  ["site-stats-v6"],
  { revalidate: 300 }
);

/** Round down to nearest 100 and append "+" e.g. 12438 → "12,400+" */
export function formatStat(n: number): string {
  const rounded = Math.floor(n / 100) * 100;
  return rounded.toLocaleString("en-US") + "+";
}
