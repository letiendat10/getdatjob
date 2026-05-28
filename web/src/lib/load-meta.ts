import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function loadMeta() {
  const [{ data: companyRows }, { data: statsRow }] = await Promise.all([
    supabase.rpc("get_active_companies"),
    supabase.from("job_stats").select("total_count,week_count,three_day_count").single(),
  ]);

  const companies = (companyRows ?? [])
    .map((r: any) => r.company as string)
    .filter(Boolean);

  return {
    companies,
    threeDayCount: statsRow?.three_day_count ?? 0,
    totalCount:    statsRow?.total_count     ?? 0,
  };
}
