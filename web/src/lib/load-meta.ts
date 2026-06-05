import { createClient } from "@supabase/supabase-js";
import { departmentLabel, type CanonicalDepartment } from "@/lib/taxonomy";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export type DepartmentFacet = { value: string; label: string; count: number };

export async function loadMeta() {
  const [{ data: companyRows }, { data: statsRow }, { data: deptRows }] = await Promise.all([
    supabase.rpc("get_active_companies"),
    supabase.from("job_stats").select("total_count,week_count,three_day_count").single(),
    supabase.rpc("department_facets"),
  ]);

  const companies = (companyRows ?? [])
    .map((r: any) => r.company as string)
    .filter(Boolean);

  // The unified department vocabulary, sourced from the actual active jobs (busiest first).
  // departmentLabel() prettifies canonical values (Marketing/Growth -> Marketing / Growth)
  // and returns any non-canonical bucket (e.g. a new "Healthcare") unchanged.
  const departments: DepartmentFacet[] = (deptRows ?? [])
    .map((r: any) => ({
      value: r.department as string,
      label: departmentLabel(r.department as CanonicalDepartment),
      count: Number(r.n) || 0,
    }))
    .filter((d: DepartmentFacet) => d.value);

  return {
    companies,
    departments,
    weekCount:     statsRow?.week_count      ?? 0,
    threeDayCount: statsRow?.three_day_count ?? 0,
    totalCount:    statsRow?.total_count     ?? 0,
  };
}
